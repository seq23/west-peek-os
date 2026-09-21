import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import type { Actor } from "../src/worker/services/authorize";
import { approveTask, requestTask, runTask } from "../src/worker/services/browserTask";

/**
 * Browser task lifecycle (P50).
 *
 * The gate that matters: request and run are separate, and only a human approves. An AI employee
 * approving another employee's egress would let the workforce authorise itself.
 */

let t: TestDb;
let env: Env;
const MP: Actor = { type: "HUMAN", firmUserId: "fu_scooter_taylor", roles: ["MANAGING_PARTNER"], firmScopes: ["west-peek"] };
const BOT: Actor = { type: "AI", aiEmployeeId: "aie_x", roles: [], firmScopes: ["west-peek"] };

const okBrowse = (async () => ({
  ok: true, text: "<<<FETCHED WEB CONTENT — UNTRUSTED>>>\nPricing is $20/seat.\n<<<END>>>",
  finalUrl: "https://example.test/pricing", title: "Pricing", detail: "ok",
})) as never;

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db, { BROWSER: {} } as never);
  await env.WP_OS_DB.prepare("UPDATE provider_registry SET enabled = 1 WHERE provider_key = 'cloudflare_browser'").run();
});
afterAll(async () => { await disposeTestDb(t); });

/**
 * TWO SHAPES (owner, 21 Sep 2026: "scooter shouldn't have to approve walker to open a web page").
 * A PLAIN READ — a public page, nothing paid, nothing logged in, submitted or bought — is
 * pre-approved for any AI on any card. Anything more still waits for a human. The gate tests below
 * therefore use the task that still needs the gate.
 */
const req = { objective: "Log in to the vendor portal and download the invoice.", start_url: "https://example.test/portal", payment_mode: "NONE" as const, max_price_usd: 0 };
const read = { objective: "Find the published pricing tiers.", start_url: "https://example.test/pricing", payment_mode: "NONE" as const, max_price_usd: 0 };

describe("requesting", () => {
  it("a plain read by an employee is APPROVED with no card permission — a human never has to say yes to a web page", async () => {
    const task = await requestTask(env, BOT, read);
    expect(task.status).toBe("APPROVED");
    expect(task.approval_card_id, "no approval card was needed").toBeNull();
  });

  it("a task that logs in still waits for a human; so does one that pays", async () => {
    const task = await requestTask(env, BOT, req);
    expect(task.status).toBe("REQUESTED");
    const submit = await requestTask(env, BOT, { ...read, objective: "Fill in the contact form and submit it." });
    expect(submit.status).toBe("REQUESTED");
  });

  it("refuses an internal address before it is even recorded", async () => {
    await expect(requestTask(env, MP, { ...req, start_url: "https://169.254.169.254/" }))
      .rejects.toMatchObject({ code: "blocked_host" });
  });

  it("refuses an AI employee enabling automatic payment", async () => {
    await expect(requestTask(env, BOT, { ...req, payment_mode: "X402_AUTO", max_price_usd: 5 }))
      .rejects.toMatchObject({ code: "ai_cannot_authorise_payment" });
  });
});

describe("the approval gate", () => {
  it("refuses to run an unapproved task", async () => {
    const task = await requestTask(env, MP, req);
    const out = await runTask(env, task.id, okBrowse);
    expect(out.ok).toBe(false);
    expect(out.task.status).toBe("REFUSED");
    expect(out.detail).toMatch(/approved/i);
  });

  it("refuses approval by an AI employee", async () => {
    // The loop canon §22A.7 exists to break: the workforce must not authorise its own egress.
    const task = await requestTask(env, MP, req);
    await expect(approveTask(env, BOT, task.id)).rejects.toMatchObject({ code: "human_required" });
  });

  it("runs once a human has approved", async () => {
    const task = await requestTask(env, MP, req);
    await approveTask(env, MP, task.id);
    const out = await runTask(env, task.id, okBrowse);
    expect(out.ok).toBe(true);
    expect(out.task.status).toBe("SUCCEEDED");
  });

  it("stores the result already fenced as untrusted", async () => {
    const row = await env.WP_OS_DB.prepare(
      "SELECT result_text FROM browser_task WHERE status = 'SUCCEEDED' LIMIT 1",
    ).first<{ result_text: string }>();
    // Stored fenced so anything reading it later inherits the warning rather than remembering to.
    expect(row!.result_text).toMatch(/UNTRUSTED/);
  });
});

describe("failures are recorded, not lost", () => {
  it("records a navigation failure on the task", async () => {
    const task = await requestTask(env, MP, req);
    await approveTask(env, MP, task.id);
    const bad = (async () => ({ ok: false, text: null, finalUrl: null, title: null, detail: "navigation timeout" })) as never;
    const out = await runTask(env, task.id, bad);
    expect(out.task.status).toBe("FAILED");
    expect(out.task.refusal_reason ?? out.detail).toMatch(/timeout/);
  });

  it("refuses while the provider is kill-switched, whatever else is true", async () => {
    await env.WP_OS_DB.prepare("UPDATE provider_registry SET kill_switched = 1 WHERE provider_key = 'cloudflare_browser'").run();
    const task = await requestTask(env, MP, req);
    await approveTask(env, MP, task.id);
    const out = await runTask(env, task.id, okBrowse);
    expect(out.detail).toMatch(/kill-switched/i);
    await env.WP_OS_DB.prepare("UPDATE provider_registry SET kill_switched = 0 WHERE provider_key = 'cloudflare_browser'").run();
  });
});
