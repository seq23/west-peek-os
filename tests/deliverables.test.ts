import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { deliver } from "../src/worker/services/deliverables";
import { exportFilename, renderMarkdown } from "../src/shared/deliverables/deliverable";

/**
 * Deliverables — the one road everything the firm produces travels.
 *
 * WHY THIS FILE EXISTS, and it is worth stating plainly because the lesson generalises.
 *
 * The first version of `deliver()` used `ON CONFLICT (source_type, source_id)` against a PARTIAL
 * unique index. SQLite requires a conflict target to match a real index INCLUDING its predicate, so
 * every call threw "ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint".
 *
 * It threw SILENTLY. Both callers wrap `deliver()` in try/catch so a handover failure cannot fail
 * the brief or the research packet it belongs to — which is right, and which meant the entire
 * feature was dead and reported nothing. Typecheck passed. 1,154 tests passed. Four validators
 * passed. It was found by running the statement against the real schema.
 *
 * So the rule these tests encode: a write path is not verified by the code around it compiling. It
 * is verified by the statement executing against the schema it will actually meet.
 */

let t: TestDb;
let env: Env;

const ACTOR = {
  type: "HUMAN" as const,
  firmUserId: "fu_sequoia_taylor",
  firmScopes: ["west-peek"],
  roles: ["MANAGING_PARTNER"],
};

/**
 * An in-memory R2, so the filing half is exercised rather than assumed.
 *
 * `document` has zero rows in production, which means `uploadDocument` has never once succeeded
 * there — and both deliverables and image generation depend on it. Without a bucket here the
 * filing throws, the catch swallows it, and the test passes while proving only the D1 write. That
 * is exactly the gap that let the whole deliverables road be dead for a day.
 */
function fakeBucket() {
  const store = new Map<string, Uint8Array>();
  return {
    store,
    bucket: {
      put: async (key: string, body: ArrayBuffer | Uint8Array) => {
        store.set(key, body instanceof Uint8Array ? body : new Uint8Array(body));
        return { key };
      },
      get: async (key: string) => {
        const bytes = store.get(key);
        return bytes ? { arrayBuffer: async () => bytes.buffer } : null;
      },
    },
  };
}

let r2: ReturnType<typeof fakeBucket>;

beforeAll(async () => {
  t = await createTestDb();
  r2 = fakeBucket();
  env = makeTestEnv(t.db, { WP_OS_DOCUMENTS: r2.bucket as never });
});

afterAll(async () => {
  await disposeTestDb(t);
});

describe("handing something over", () => {
  it("writes a deliverable against the real schema", async () => {
    // The assertion that would have caught the bug: not that the code compiles, that it runs.
    const row = await deliver(env, ACTOR as never, {
      kind: "research_packet",
      title: "Which accelerators back pre-seed B2B in Texas",
      body: "Capital Factory and Sputnik ATX both do.",
      preparedBy: "Wyatt",
      preparedFor: "fu_sequoia_taylor",
      sourceType: "research_packet",
      sourceId: "rpkt_test_1",
    });
    expect(row.id).toMatch(/^dlv_/);
    expect(row.prepared_by).toBe("Wyatt");
    expect(row.kind).toBe("research_packet");
  });

  it("re-delivering the same source updates it rather than stacking a duplicate", async () => {
    // The whole reason the partial unique index exists. Regenerating a brief must not leave two
    // copies of it on somebody's Home page.
    await deliver(env, ACTOR as never, {
      kind: "research_packet",
      title: "First version",
      body: "one",
      preparedBy: "Wyatt",
      preparedFor: "fu_sequoia_taylor",
      sourceType: "research_packet",
      sourceId: "rpkt_test_2",
    });
    await deliver(env, ACTOR as never, {
      kind: "research_packet",
      title: "Second version",
      body: "two",
      preparedBy: "Wyatt",
      preparedFor: "fu_sequoia_taylor",
      sourceType: "research_packet",
      sourceId: "rpkt_test_2",
    });

    const rows = await env.WP_OS_DB.prepare(
      "SELECT title, body FROM deliverable WHERE source_type = 'research_packet' AND source_id = 'rpkt_test_2'",
    ).all<{ title: string; body: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results![0]!.title).toBe("Second version");
  });

  it("allows two deliverables that carry no source at all", async () => {
    // The index is partial precisely so that source-less deliverables do not collide with each
    // other on a pair of NULLs. If the predicate were dropped this would start failing.
    await deliver(env, ACTOR as never, {
      kind: "ask_brief", title: "A", body: "a", preparedBy: "Wren", preparedFor: "fu_sequoia_taylor",
    });
    await deliver(env, ACTOR as never, {
      kind: "ask_brief", title: "B", body: "b", preparedBy: "Wren", preparedFor: "fu_sequoia_taylor",
    });
    const n = await env.WP_OS_DB.prepare(
      "SELECT COUNT(*) AS n FROM deliverable WHERE source_type IS NULL",
    ).first<{ n: number }>();
    expect(n!.n).toBe(2);
  });
});

describe("what leaves the building", () => {
  const sample = {
    kind: "daily_brief",
    title: "Morning brief — 2026-08-19",
    body: "## What moved\n\nNothing much.",
    preparedBy: "Wren",
    preparedFor: "Sequoia Taylor",
    preparedAt: "2026-08-19T06:00:00.000Z",
  };

  it("signs the file itself, not just the record", () => {
    // A document that leaves the system saying who prepared it stays attributable after it has
    // been forwarded twice. Metadata does not survive a copy-paste; a line in the body does.
    const md = renderMarkdown(sample);
    expect(md).toContain("Prepared by Wren for Sequoia Taylor");
    expect(md).toContain("Morning brief");
    expect(md).toContain("Nothing much.");
  });

  it("names the file the way a person would recognise it months later", () => {
    expect(exportFilename(sample)).toBe("2026-08-19-morning-brief-2026-08-19.md");
  });
});

describe("the filing half, which had never run anywhere", () => {
  it("writes the bytes to R2 and records the document against the deliverable", async () => {
    // `document` has zero rows in production. This is the first execution of that path anywhere.
    const before = r2.store.size;
    const row = await deliver(env, ACTOR as never, {
      kind: "ask_brief",
      title: "Filing probe",
      body: "The body that should end up in the bucket.",
      preparedBy: "Wren",
      preparedFor: "fu_sequoia_taylor",
      sourceType: "probe",
      sourceId: "filing_1",
    });

    expect(row.document_id).toBeTruthy();
    expect(r2.store.size).toBe(before + 1);

    // The filed copy is the rendered document, not the raw body — signed, so it stays
    // attributable after it has been forwarded twice.
    const key = [...r2.store.keys()].find((k) => k.includes(row.document_id!))!;
    const filed = new TextDecoder().decode(r2.store.get(key)!);
    expect(filed).toContain("Prepared by Wren");
    expect(filed).toContain("The body that should end up in the bucket.");
  });

  it("keeps the deliverable when filing fails, and says it is unfiled", async () => {
    // The non-fatal wrapping is deliberate: losing a handover because the archive is down would be
    // the wrong trade. What must not happen is the failure being invisible — see recordSwallowed.
    const broken = makeTestEnv(t.db, {
      WP_OS_DOCUMENTS: { put: async () => { throw new Error("bucket down"); } } as never,
    });
    const row = await deliver(broken, ACTOR as never, {
      kind: "ask_brief",
      title: "Unfiled probe",
      body: "still delivered",
      preparedBy: "Wren",
      preparedFor: "fu_sequoia_taylor",
      sourceType: "probe",
      sourceId: "filing_2",
    });
    expect(row.id).toBeTruthy();
    expect(row.document_id).toBeNull();

    // And the failure is on the record rather than lost.
    const ev = await t.db
      .prepare("SELECT COUNT(*) AS n FROM event_record WHERE event_type = 'system.swallowed_failure'")
      .first<{ n: number }>();
    expect(ev!.n).toBeGreaterThan(0);
  });
});
