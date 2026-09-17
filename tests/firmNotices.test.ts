import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { handleRequest } from "../src/worker/index";
import { runAi } from "../src/worker/ai/runAi";
import { firmNoticesBlock } from "../src/worker/ai/firmNotices";
import type { Actor } from "../src/worker/services/authorize";

/**
 * Firmwide notices, and the one thing that decides whether they are real.
 *
 * `internal_memo` has had a create route, a list route and an append-only trigger since 0014, and
 * held ZERO ROWS, because nothing read it into a prompt. This repository has now watched three
 * specifications pass every test while no code read them. So the assertion that matters here is not
 * "the row exists" or "the endpoint returns it" — it is that the notice's own words are in the
 * BYTES SENT TO THE PROVIDER on an employee's run.
 *
 * Every test below is written to fail loudly rather than pass on an empty set: the seeded count is
 * asserted first, so a migration that stopped seeding cannot leave a suite of vacuously-true
 * assertions behind it.
 */

let t: TestDb;
let env: Env;

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };

const MP_ACTOR: Actor = {
  type: "HUMAN",
  firmUserId: "fu_scooter_taylor",
  roles: ["MANAGING_PARTNER"],
  firmScopes: ["west-peek"],
};

/** Records the request bodies actually put on the wire, and answers in every vendor shape. */
function stubFetch() {
  const bodies: string[] = [];
  const fetchImpl = (async (_url: unknown, init?: unknown) => {
    const body = (init as { body?: unknown } | undefined)?.body;
    bodies.push(typeof body === "string" ? body : body === undefined ? "" : String(body));
    return new Response(
      JSON.stringify({
        text: "stubbed provider output",
        model: "stub-model",
        usage: { input_tokens: 10, output_tokens: 20, cost_usd: 0.001, prompt_tokens: 10, completion_tokens: 20 },
        choices: [{ message: { content: "stubbed provider output" } }],
        content: [{ type: "text", text: "stubbed provider output" }],
        candidates: [{ content: { parts: [{ text: "stubbed provider output" }] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { bodies, fetchImpl };
}

beforeAll(async () => {
  t = await createTestDb();
  // Credentials, so runs take the external lane and a request body actually exists to inspect.
  // Without one, every run resolves to the local mock and this file would prove nothing at all.
  env = makeTestEnv(t.db, {
    OPENAI_API_KEY: "test-openai",
    WP_ANTHROPIC_API_KEY: "test-anthropic",
    GEMINI_API_KEY: "test-gemini",
  });
  await allowExternalRuns();
});

afterAll(async () => {
  await disposeTestDb(t);
});

/**
 * FRONTIER + every provider enabled, so a run actually leaves the building and there is a request
 * body to inspect. Egress is default-deny here, exactly as in production; a file that forgot this
 * would pass its assertions against the local mock and prove nothing.
 */
async function allowExternalRuns(): Promise<void> {
  await t.db
    .prepare(
      `INSERT INTO budget_policy (id, firm_scope, cost_mode, privacy_mode, daily_cap_usd, per_run_cap_usd, set_by)
       VALUES (?1, 'west-peek', 'NORMAL', 'FRONTIER', 100, 100, 'firmNotices test')`,
    )
    .bind(`bp_notices_${crypto.randomUUID()}`)
    .run();
  await t.db.prepare("UPDATE provider_registry SET enabled = 1").run();
}

async function seededNotices(): Promise<Array<{ id: string; title: string; body: string }>> {
  return (
    (
      await t.db
        .prepare("SELECT id, title, body FROM internal_memo WHERE audience = 'FIRM' ORDER BY id")
        .all<{ id: string; title: string; body: string }>()
    ).results ?? []
  );
}

describe("the firm has actually written its notices down", () => {
  it("seeds twelve firmwide notices, and refuses to pass on an empty table", async () => {
    const rows = await seededNotices();
    // RULE 0. If 0181 ever stops seeding, this file must go red rather than quietly assert nothing.
    expect(rows.length, "no firmwide notices are seeded — every assertion below would be vacuous").toBeGreaterThan(0);
    expect(rows).toHaveLength(12);
  });

  it("names the two Managing Partners, both platform rules and the send prohibition", async () => {
    const all = (await seededNotices()).map((r) => `${r.title}\n${r.body}`).join("\n\n");
    expect(all).toContain("sequoia@westpeek.ventures");
    expect(all).toContain("scooter@westpeek.ventures");
    expect(all).toContain("West Peek Live");
    expect(all).toContain("Employees draft. A person sends.");
    expect(all).toContain("West Peek Productions");
  });

  it("does NOT carry the spend ladder, which is enforced in code and not actionable by an employee", async () => {
    const all = (await seededNotices()).map((r) => `${r.title}\n${r.body}`).join("\n\n");
    expect(all).not.toContain("spend ladder");
  });
});

describe("a notice reaches the employee, which is the entire point", () => {
  it("puts every seeded notice into the block an employee is given", async () => {
    const rows = await seededNotices();
    expect(rows.length).toBeGreaterThan(0);
    const block = await firmNoticesBlock(env, "west-peek");
    expect(block).toContain("NOTICES FROM THE FIRM");
    for (const r of rows) {
      expect(block, `notice missing from the employee's context: ${r.title}`).toContain(r.title);
    }
  });

  it("sends a notice's own words to the provider on an employee's run", async () => {
    const rows = await seededNotices();
    expect(rows.length).toBeGreaterThan(0);
    const stub = stubFetch();

    const { run } = await runAi(
      env,
      {
        purpose: "notices reach an employee run",
        actor: MP_ACTOR,
        inputs: ["Write two sentences about nothing in particular."],
        sensitivity: "PUBLIC",
        // Marked as real employee work would be, so the spend gradient cannot defer it and leave
        // this file asserting against a run that never happened.
        budgetContext: { judgement: true, expectedOutputTokens: 200 },
        // What makes this an EMPLOYEE's run rather than a mechanical one.
        aiEmployeeId: "aie_pierce",
      },
      { fetchImpl: stub.fetchImpl },
    );

    expect(run.status, `run did not complete: ${run.failure_reason ?? ""}`).toBe("COMPLETED");
    expect(stub.bodies.length, "no provider request was made, so nothing was proven").toBeGreaterThan(0);

    // Not the block, not the row — the bytes. A redaction that left the original in the request
    // and a notice that never reached it look identical from anywhere else.
    const sent = stub.bodies.join("\n");
    expect(sent).toContain("NOTICES FROM THE FIRM");
    expect(sent).toContain("West Peek Live is the only platform for virtual events");
    expect(sent).toContain("Employees draft. A person sends.");
    for (const r of rows) {
      expect(sent, `notice never reached the provider: ${r.title}`).toContain(r.title);
    }
  });

  it("leaves a run with no employee behind it exactly as it was", async () => {
    const stub = stubFetch();
    const { run } = await runAi(
      env,
      {
        purpose: "mechanical run, nobody is being instructed",
        actor: MP_ACTOR,
        inputs: ["Extract the date from: 3 March 2026."],
        sensitivity: "PUBLIC",
        // Marked as real employee work would be, so the spend gradient cannot defer it and leave
        // this file asserting against a run that never happened.
        budgetContext: { judgement: true, expectedOutputTokens: 200 },
      },
      { fetchImpl: stub.fetchImpl },
    );
    expect(run.status).toBe("COMPLETED");
    expect(stub.bodies.length).toBeGreaterThan(0);
    expect(stub.bodies.join("\n")).not.toContain("NOTICES FROM THE FIRM");
  });

  /**
   * THE NEGATIVE PROOF, run in-process rather than described in a comment.
   *
   * With the notices removed from the table, the identical employee run must stop carrying them —
   * and must not carry an empty heading either. If this passed with the table emptied, the
   * assertions above would be proving that some constant string exists, not that the notices are
   * what reach the prompt.
   */
  it("stops reaching the provider when the firm has written nothing — and says nothing rather than an empty heading", async () => {
    const saved = (
      await t.db.prepare("SELECT * FROM internal_memo WHERE audience = 'FIRM'").all<Record<string, unknown>>()
    ).results ?? [];
    expect(saved.length).toBeGreaterThan(0);

    await t.db.prepare("DELETE FROM internal_memo WHERE audience = 'FIRM'").run();
    try {
      expect(await firmNoticesBlock(env, "west-peek")).toBe("");

      const stub = stubFetch();
      const { run } = await runAi(
        env,
        {
          purpose: "employee run with no notices written",
          actor: MP_ACTOR,
          inputs: ["Write two sentences about nothing in particular."],
          sensitivity: "PUBLIC",
        // Marked as real employee work would be, so the spend gradient cannot defer it and leave
        // this file asserting against a run that never happened.
        budgetContext: { judgement: true, expectedOutputTokens: 200 },
          aiEmployeeId: "aie_pierce",
        },
        { fetchImpl: stub.fetchImpl },
      );
      expect(run.status).toBe("COMPLETED");
      expect(stub.bodies.length).toBeGreaterThan(0);
      const sent = stub.bodies.join("\n");
      expect(sent).not.toContain("NOTICES FROM THE FIRM");
      expect(sent).not.toContain("West Peek Live is the only platform");
    } finally {
      for (const row of saved) {
        await t.db
          .prepare(
            `INSERT OR IGNORE INTO internal_memo (id, author_type, author_id, audience, department, title, body, privacy_label, firm_scope, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
          )
          .bind(
            row.id,
            row.author_type,
            row.author_id,
            row.audience,
            row.department ?? null,
            row.title,
            row.body,
            row.privacy_label,
            row.firm_scope,
            row.created_at,
          )
          .run();
      }
    }

    // Restored, and provably so — a negative proof that left the firm empty would be a defect.
    expect((await seededNotices()).length).toBe(12);
  });
});

describe("a partner can write a notice, and it lands where employees read it", () => {
  it("writes one through the API and it is in the next employee's prompt", async () => {
    const res = await handleRequest(
      new Request("https://test.local/api/workforce/memos", {
        method: "POST",
        headers: { ...MP, "content-type": "application/json" },
        body: JSON.stringify({
          audience: "FIRM",
          title: "Deck reviews name the customer first",
          body: "Before the technology, before the team, say who is paying for this today.",
        }),
      }),
      env,
    );
    expect(res.status).toBe(201);

    const stub = stubFetch();
    const { run } = await runAi(
      env,
      {
        purpose: "a newly written notice reaches the next run",
        actor: MP_ACTOR,
        inputs: ["Write two sentences about nothing in particular."],
        sensitivity: "PUBLIC",
        // Marked as real employee work would be, so the spend gradient cannot defer it and leave
        // this file asserting against a run that never happened.
        budgetContext: { judgement: true, expectedOutputTokens: 200 },
        aiEmployeeId: "aie_pierce",
      },
      { fetchImpl: stub.fetchImpl },
    );
    expect(run.status).toBe("COMPLETED");
    expect(stub.bodies.join("\n")).toContain("Deck reviews name the customer first");

    // Housekeeping so the seeded count stays meaningful for any later file-local assertion.
    await t.db.prepare("DELETE FROM internal_memo WHERE title = 'Deck reviews name the customer first'").run();
  });

  it("a DEPARTMENT memo is not a firmwide notice and is not read to everyone", async () => {
    await t.db
      .prepare(
        `INSERT INTO internal_memo (id, author_type, author_id, audience, department, title, body)
         VALUES ('memo_dept_test', 'HUMAN', 'fu_scooter_taylor', 'DEPARTMENT', 'research', 'Research standup moved to Tuesday', 'Not a firmwide standing fact.')`,
      )
      .run();
    const block = await firmNoticesBlock(env, "west-peek");
    expect(block).not.toContain("Research standup moved to Tuesday");
    await t.db.prepare("DELETE FROM internal_memo WHERE id = 'memo_dept_test'").run();
  });
});
