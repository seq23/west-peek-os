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
