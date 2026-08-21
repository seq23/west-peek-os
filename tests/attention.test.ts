import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { handleRequest } from "../src/worker/index";
import type { Env } from "../src/worker/env";
import { DISMISSAL_LIFETIME_DAYS, silencedAttention } from "../src/worker/services/attention";
import { attentionSignature } from "../src/shared/setup/attentionKey";

/**
 * Silencing something on "Needs your attention".
 *
 * THE DANGEROUS VERSION OF THIS FEATURE remembers the item's key and nothing else. The operator
 * dismisses "no AI provider is configured" on a Tuesday when they already know, and the firm is
 * never told again — including the next time it is true, for a different reason, months later. An
 * alert you can permanently disable is an alert that will one day be disabled when it matters.
 *
 * So these tests are mostly about coming BACK: when the words change, and when a week has passed.
 */

let t: TestDb;
let env: Env;
const MP = { "x-wpos-dev-user": "sequoia@westpeek.ventures" };

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
});
afterAll(async () => {
  await disposeTestDb(t);
});

function req(path: string, method = "GET", body?: unknown): Request {
  return new Request(`https://test.local${path}`, {
    method,
    headers: body === undefined ? MP : { ...MP, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("silencing an attention item", () => {
  it("goes quiet for the exact thing it was shown", async () => {
    const res = await handleRequest(
      req("/api/attention/no_provider/dismiss", "POST", { signature: "No AI provider is configured", kind: "DISMISSED" }),
      env,
    );
    expect(res.status).toBe(200);

    const quiet = await silencedAttention(env);
    expect(quiet.has(attentionSignature("no_provider", "No AI provider is configured"))).toBe(true);
  });

  it("speaks up again when the situation changes, because the words change with it", async () => {
    await handleRequest(
      req("/api/attention/failing_job/dismiss", "POST", { signature: "1 scheduled job is failing" }),
      env,
    );
    const quiet = await silencedAttention(env);

    // Same key, different reading — a second job started failing. That is news, not the thing the
    // operator waved away, and it must not inherit the silence.
    expect(quiet.has(attentionSignature("failing_job", "1 scheduled job is failing"))).toBe(true);
    expect(quiet.has(attentionSignature("failing_job", "2 scheduled jobs are failing"))).toBe(false);
  });

  it("lapses after a week — 'I know' last Tuesday is not 'I know' today", async () => {
    await env.WP_OS_DB.prepare(
      `INSERT INTO attention_dismissal (id, item_key, signature, kind, dismissed_by, firm_scope, created_at)
       VALUES ('atd_old', 'stale_item', 'something old', 'DISMISSED', 'fu_sequoia_taylor', 'west-peek', ?1)`,
    )
      .bind(new Date(Date.now() - (DISMISSAL_LIFETIME_DAYS + 1) * 86_400_000).toISOString())
      .run();

    const quiet = await silencedAttention(env);
    expect(quiet.has(attentionSignature("stale_item", "something old"))).toBe(false);
  });

  it("distinguishes 'I know' from 'stop telling me' on the record", async () => {
    await handleRequest(
      req("/api/attention/known_thing/dismiss", "POST", { signature: "Two employees are paused", kind: "ACKNOWLEDGED" }),
      env,
    );
    const row = await env.WP_OS_DB.prepare(
      "SELECT kind FROM attention_dismissal WHERE item_key = 'known_thing'",
    ).first<{ kind: string }>();
    expect(row?.kind).toBe("ACKNOWLEDGED");

    const events = await env.WP_OS_DB.prepare(
      "SELECT event_type FROM event_record WHERE object_type = 'attention_item' AND object_id = 'known_thing'",
    ).first<{ event_type: string }>();
    expect(events?.event_type).toBe("attention.acknowledged");
  });

  it("brings everything back on request", async () => {
    expect((await silencedAttention(env)).size).toBeGreaterThan(0);
    const res = await handleRequest(req("/api/attention/silenced/clear", "POST", {}), env);
    expect(res.status).toBe(200);
    expect((await silencedAttention(env)).size).toBe(0);
  });

  it("refuses a dismissal with no signature rather than silencing the key outright", async () => {
    // A signature-less dismissal would be the permanent kind this design exists to avoid.
    const res = await handleRequest(req("/api/attention/anything/dismiss", "POST", { signature: "  " }), env);
    expect(res.status).toBe(400);
  });

  it("is refused when nobody is signed in", async () => {
    const res = await handleRequest(
      new Request("https://test.local/api/attention/x/dismiss", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ signature: "x" }),
      }),
      env,
    );
    expect(res.status).toBe(401);
  });
});

/*
 * "I know" and "Stop telling me" wrote the same row and both lapsed after a week, so the two
 * buttons were synonyms with different labels. The operator noticed. They now mean what they say.
 */
describe("the two buttons do different things", () => {
  it("keeps a DISMISSED item silenced past the week an acknowledgement lapses in", async () => {
    await handleRequest(
      req("/api/attention/jobs-paused/dismiss", "POST", { signature: "2 scheduled job(s) are paused.", kind: "DISMISSED" }),
      env,
    );
    // Age it well past the acknowledgement lifetime.
    await t.db
      .prepare(
        `UPDATE attention_dismissal SET created_at = ?1 WHERE item_key = 'jobs-paused'`,
      )
      .bind(new Date(Date.now() - (DISMISSAL_LIFETIME_DAYS + 30) * 86_400_000).toISOString())
      .run();

    const silenced = await silencedAttention(env);
    expect([...silenced].some((s) => s.startsWith("jobs-paused"))).toBe(true);
  });

  it("lets an ACKNOWLEDGED item come back after the week, because 'I know' was about that week", async () => {
    await handleRequest(
      req("/api/attention/setup-incomplete/dismiss", "POST", {
        signature: "2 recommended AI employee(s) are not activated.",
        kind: "ACKNOWLEDGED",
      }),
      env,
    );
    await t.db
      .prepare(`UPDATE attention_dismissal SET created_at = ?1 WHERE item_key = 'setup-incomplete'`)
      .bind(new Date(Date.now() - (DISMISSAL_LIFETIME_DAYS + 1) * 86_400_000).toISOString())
      .run();

    const silenced = await silencedAttention(env);
    expect([...silenced].some((s) => s.startsWith("setup-incomplete"))).toBe(false);
  });

  it("still speaks up when the same problem arrives with different wording", async () => {
    // This is what makes a permanent option safe: silencing "3 jobs failed" for ever must not also
    // silence "9 jobs failed". A different fact deserves to be said.
    await handleRequest(
      req("/api/attention/jobs-refused/dismiss", "POST", { signature: "3 scheduled job(s) recently failed", kind: "DISMISSED" }),
      env,
    );
    const silenced = await silencedAttention(env);
    expect(silenced.has(attentionSignature("jobs-refused", "3 scheduled job(s) recently failed"))).toBe(true);
    expect(silenced.has(attentionSignature("jobs-refused", "9 scheduled job(s) recently failed"))).toBe(false);
  });

  it("says plainly which kind of silence the operator just chose", async () => {
    const res = await handleRequest(
      req("/api/attention/no-provider/dismiss", "POST", { signature: "No AI provider is enabled.", kind: "DISMISSED" }),
      env,
    );
    const body = (await res.json()) as { permanent: boolean; note?: string; silenced_for_days?: number };
    expect(body.permanent).toBe(true);
    expect(body.note).toContain("will not come back");
    expect(body.silenced_for_days).toBeUndefined();
  });
});
