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

// ── Answering something that was prepared for you ────────────────────────────
//
// THE COMPLAINT THIS CAME FROM: three identical "Weekly operating brief" entries, one of them
// addressed to a service account, and no way to say "read it", "not this", or "do it differently
// next time". These tests hold each of those three verbs to its actual meaning — in particular
// that dismissing HIDES and never destroys, and that feedback reaches the employee's next prompt
// rather than sitting in a table nobody reads.

import { handleRequest } from "../src/worker/index";
import { recentFeedbackFor } from "../src/worker/services/deliverables";

const AS_MP = { "x-wpos-dev-user": "sequoia@westpeek.ventures" };

function apiReq(path: string, method = "GET", body?: unknown): Request {
  return new Request(`https://test.local${path}`, {
    method,
    headers: body === undefined ? AS_MP : { ...AS_MP, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function listDeliverables(query = ""): Promise<Array<Record<string, unknown>>> {
  const res = await handleRequest(apiReq(`/api/deliverables?limit=50${query}`), env);
  expect(res.status).toBe(200);
  return ((await res.json()) as { deliverables: Array<Record<string, unknown>> }).deliverables;
}

describe("answering a deliverable", () => {
  async function make(title: string): Promise<string> {
    const row = await deliver(env, ACTOR, {
      kind: "weekly_review",
      title,
      body: "the agenda",
      preparedBy: "Walker",
      preparedFor: "fu_sequoia_taylor",
    });
    return row.id;
  }

  it("marks one as read without moving it off the page", async () => {
    const id = await make("read me");
    expect((await handleRequest(apiReq(`/api/deliverables/${id}/acknowledge`, "POST", {}), env)).status).toBe(200);

    const rows = await listDeliverables();
    const row = rows.find((r) => r.id === id);
    expect(row, "an acknowledged deliverable must still be listed").toBeTruthy();
    expect(row!.acknowledged_at).toBeTruthy();
    expect(row!.acknowledged_by).toBe("fu_sequoia_taylor");
  });

  it("hides a dismissed one and gives it back — it is never destroyed", async () => {
    const id = await make("put me away");
    expect((await handleRequest(apiReq(`/api/deliverables/${id}/dismiss`, "POST", {}), env)).status).toBe(200);

    expect((await listDeliverables()).some((r) => r.id === id), "dismissed must leave the default view").toBe(false);
    expect((await listDeliverables("&dismissed=1")).some((r) => r.id === id), "and must be findable").toBe(true);

    // The row itself still exists in full — this is the assertion that separates hiding from deleting.
    const still = await env.WP_OS_DB.prepare("SELECT body FROM deliverable WHERE id = ?1").bind(id).first<{ body: string }>();
    expect(still?.body).toBe("the agenda");

    expect((await handleRequest(apiReq(`/api/deliverables/${id}/dismiss?restore=1`, "POST", {}), env)).status).toBe(200);
    expect((await listDeliverables()).some((r) => r.id === id), "restoring must bring it back").toBe(true);
  });

  it("carries feedback to the employee who signed it, and into their next prompt", async () => {
    const id = await make("too long");
    const res = await handleRequest(
      apiReq(`/api/deliverables/${id}/feedback`, "POST", { note: "Half this length and lead with private markets.", verdict: "TOO_LONG" }),
      env,
    );
    expect(res.status).toBe(201);

    // The whole point: it reaches the next run's prompt, not just a table.
    const block = await recentFeedbackFor(env, "Walker");
    expect(block).toContain("Half this length");
    expect(block).toContain("too long");

    // And it is addressed — another employee's prompt must not carry it.
    expect(await recentFeedbackFor(env, "Wyatt")).toBe("");
  });

  /*
   * The weekly review is signed "Walker and Wren". Storing feedback against that string means
   * neither of them ever sees it — the note goes to an employee who does not exist.
   */
  it("reaches BOTH employees when the piece was signed jointly", async () => {
    const row = await deliver(env, ACTOR, {
      kind: "weekly_review",
      title: "joint",
      body: "the agenda",
      preparedBy: "Walker and Wren",
      preparedFor: "fu_sequoia_taylor",
    });
    const res = await handleRequest(
      apiReq(`/api/deliverables/${row.id}/feedback`, "POST", { note: "Cut the preamble.", verdict: "TOO_LONG" }),
      env,
    );
    expect(res.status).toBe(201);

    expect(await recentFeedbackFor(env, "Walker")).toContain("Cut the preamble");
    expect(await recentFeedbackFor(env, "Wren")).toContain("Cut the preamble");
    // And never stored against the byline as though it were a person.
    const ghost = await env.WP_OS_DB.prepare(
      "SELECT COUNT(*) AS n FROM deliverable_feedback WHERE to_employee = 'Walker and Wren'",
    ).first<{ n: number }>();
    expect(ghost?.n).toBe(0);
  });

  /*
   * "Prepared for you" listed both partners' briefs. Because the other partner's is often built
   * later in the day, theirs sat ABOVE the reader's, signed by THEIR chief of staff — so the page
   * appeared to say the reader's chief of staff had changed. The byline was right all along; the
   * list was wrong.
   */
  it("lists only what was prepared for the reader when asked for mine", async () => {
    await deliver(env, ACTOR, {
      kind: "daily_brief", title: "Sequoia's brief", body: "hers",
      preparedBy: "Wren", preparedFor: "fu_sequoia_taylor",
    });
    await deliver(env, ACTOR, {
      kind: "daily_brief", title: "Scooter's brief", body: "his",
      preparedBy: "Walker", preparedFor: "fu_scooter_taylor",
    });

    const mine = await listDeliverables("&kind=daily_brief&mine=1");
    expect(mine.length).toBeGreaterThan(0);
    for (const row of mine) {
      expect(row.prepared_for, "a list promising 'for you' must not carry the other partner's").toBe("fu_sequoia_taylor");
    }
    expect(mine.some((r) => r.prepared_by === "Walker"), "Walker signs Scooter's brief, never hers").toBe(false);

    // Sharing still works where it is wanted, and the row says whose it is.
    const shared = await listDeliverables("&kind=daily_brief");
    expect(shared.some((r) => r.prepared_for === "fu_scooter_taylor")).toBe(true);
    const his = shared.find((r) => r.prepared_for === "fu_scooter_taylor");
    expect(his?.prepared_for_name, "a shared row must be able to say whose it is").toBeTruthy();
  });

  it("refuses empty feedback rather than sending an employee a blank note", async () => {
    const id = await make("blank");
    const res = await handleRequest(apiReq(`/api/deliverables/${id}/feedback`, "POST", { note: "   " }), env);
    expect(res.status).toBe(400);
  });

  it("says not_found for a deliverable that does not exist, on every verb", async () => {
    for (const path of ["acknowledge", "dismiss", "feedback"]) {
      const res = await handleRequest(apiReq(`/api/deliverables/dlv_nope/${path}`, "POST", { note: "x" }), env);
      expect(res.status, path).toBe(404);
    }
  });
});

/*
 * `POST /api/intent/brief` had no authorization check at all.
 *
 * Every sibling handler has one — draft-a-card gates on `work_card.create`, work-a-card on
 * `ai.run` — and `runAi` does not authorize either. So nothing stood between any authenticated
 * identity and an unbounded AI run that files a document signed in an employee's name. That
 * includes `fu_browser_agent`: the read-only service account with no roles, which is what the
 * browser automation presents and what a Cloudflare Access service token resolves to.
 *
 * The governing rule is one authorization choke point and no exceptions. This was an exception.
 */
describe("commissioning a brief passes the authorization choke point", () => {
  it("refuses the read-only service account, which holds no roles", async () => {
    const res = await handleRequest(
      new Request("https://test.local/api/intent/brief", {
        method: "POST",
        headers: { "x-wpos-dev-user": "browser-agent@westpeek.ventures", "content-type": "application/json" },
        body: JSON.stringify({ title: "Something expensive", question: "What would this cost the firm?" }),
      }),
      env,
    );
    // Refused outright. `ai.run` is neither reserved nor an external effect, so the choke point
    // alone allows any authenticated identity — the role gate is what closes this.
    expect(res.status).toBe(403);
    const body = (await res.json()) as { detail: string };
    expect(body.detail).toContain("Managing Partner");
  });
});

/**
 * A PARTNER WHO HAS NEVER SIGNED IN MUST NOT OPEN ON THREE WEEKS OF SUPERSEDED BRIEFS.
 *
 * Operator, 9 Sep 2026, about Scooter: "make sure his home page is cleared of things to be put away
 * and old briefings just surface the latest 1".
 *
 * She is describing something the data confirms exactly. `fu_scooter_taylor` has ZERO events on the
 * spine, zero notifications read, zero approvals decided and zero deliverables acknowledged or
 * dismissed — he has never used the product — while 20 deliverables accumulated against his name,
 * 13 of them daily briefs going back to 20 August. His first sight of West Peek OS would have been
 * a stack of superseded morning briefs, each offering a Dismiss button for a decision he never made.
 *
 * DERIVED, NEVER WRITTEN. Marking them dismissed would record that he decided something about
 * documents he has not seen — the same confusion between "handled", "seen" and "gone" that made the
 * unread badge untrustworthy. Nothing is written: an older brief simply stops being CURRENT because
 * the next one replaced it, and `?superseded=1` still returns every one.
 */
describe("only the latest morning brief is still a delivery", () => {
  const HERS = "fu_sequoia_taylor";
  const HIS = "fu_scooter_taylor";

  /*
   * Its own database. The suite above already delivers briefs for both partners as fixtures, and
   * "the latest" is only a meaningful assertion over a set this block controls entirely.
   */
  let sup: TestDb;
  let supEnv: Env;

  beforeAll(async () => {
    sup = await createTestDb();
    supEnv = makeTestEnv(sup.db);
  });
  afterAll(async () => {
    await disposeTestDb(sup);
  });

  async function list(query = ""): Promise<Array<Record<string, unknown>>> {
    const res = await handleRequest(apiReq(`/api/deliverables?limit=50${query}`), supEnv);
    expect(res.status).toBe(200);
    return ((await res.json()) as { deliverables: Array<Record<string, unknown>> }).deliverables;
  }

  async function brief(forWhom: string, day: string): Promise<string> {
    const row = await deliver(supEnv, ACTOR, {
      kind: "daily_brief",
      title: `Morning brief ${day} for ${forWhom}`,
      body: "what moved overnight",
      preparedBy: forWhom === HIS ? "Walker" : "Wren",
      preparedFor: forWhom,
      // Keyed like the real pipeline, so each day is its own row rather than an upsert.
      sourceType: "intelligence_report",
      sourceId: `${day}:${forWhom}`,
    });
    // The rule keys on created_at, and three inserts inside one millisecond would make "latest"
    // ambiguous. Stamped explicitly so the ordering under test is the one being asserted.
    await supEnv.WP_OS_DB.prepare("UPDATE deliverable SET created_at = ?2 WHERE id = ?1")
      .bind(row.id, `${day}T11:00:00.000Z`)
      .run();
    return row.id;
  }

  it("hides the superseded ones and keeps exactly the newest", async () => {
    await brief(HIS, "2026-08-20");
    await brief(HIS, "2026-08-21");
    const newest = await brief(HIS, "2026-09-09");

    const all = await list("&superseded=1");
    const hisAll = all.filter((d) => d.prepared_for === HIS && d.kind === "daily_brief");
    // The premise, asserted: three really are stored, so the filtering below means something.
    expect(hisAll.length, "the briefs were not stored, so there is nothing to supersede").toBe(3);

    const current = await list();
    const hisCurrent = current.filter((d) => d.prepared_for === HIS && d.kind === "daily_brief");
    expect(hisCurrent.length, "his page still carries superseded briefs").toBe(1);
    expect(hisCurrent[0]!.id).toBe(newest);
  });

  it("supersedes per person, so her latest never hides his", async () => {
    await brief(HERS, "2026-09-09");
    const current = await list();
    const byWhom = current.filter((d) => d.kind === "daily_brief");
    expect(byWhom.length, "one brief each, and only one each").toBe(2);
    expect(new Set(byWhom.map((d) => d.prepared_for))).toEqual(new Set([HIS, HERS]));
  });

  it("writes NOTHING to the rows it hides — they are not dismissed on his behalf", async () => {
    /*
     * The half that matters most. Hiding by marking them dismissed would put a decision he never
     * made onto rows he has never seen, and `dismissed_by` would name him.
     */
    const rows = (
      await supEnv.WP_OS_DB.prepare(
        "SELECT dismissed_at, dismissed_by, acknowledged_at FROM deliverable WHERE kind = 'daily_brief' AND prepared_for = ?1",
      ).bind(HIS).all<{ dismissed_at: string | null; dismissed_by: string | null; acknowledged_at: string | null }>()
    ).results ?? [];
    expect(rows.length, "no briefs to check").toBe(3);
    for (const r of rows) {
      expect(r.dismissed_at, "a superseded brief was recorded as dismissed").toBeNull();
      expect(r.dismissed_by).toBeNull();
      expect(r.acknowledged_at, "a superseded brief was recorded as read").toBeNull();
    }
  });

  it("keeps every superseded brief reachable, because history is not deleted", async () => {
    const all = await list("&superseded=1");
    expect(all.filter((d) => d.prepared_for === HIS && d.kind === "daily_brief").length).toBe(3);
  });

  it("never supersedes anything that is referred back to", async () => {
    // A weekly review, a research packet and a discrepancy register are looked up again; a brief is
    // read on the morning it is about. Only the brief is superseded, and this is what pins that.
    await deliver(supEnv, ACTOR, {
      kind: "weekly_review", title: "Week of 2026-09-02", body: "agenda",
      preparedBy: "Walker and Wren", preparedFor: HIS,
      sourceType: "weekly_review", sourceId: "wr_super_1",
    });
    await deliver(supEnv, ACTOR, {
      kind: "weekly_review", title: "Week of 2026-09-09", body: "agenda",
      preparedBy: "Walker and Wren", preparedFor: HIS,
      sourceType: "weekly_review", sourceId: "wr_super_2",
    });
    const current = await list();
    expect(current.filter((d) => d.kind === "weekly_review" && d.prepared_for === HIS).length).toBe(2);
  });
});
