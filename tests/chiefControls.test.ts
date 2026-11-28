import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PARTNERS } from "../src/shared/registry/partners";
import { claimRun, parkRun, progressRun, reportRun } from "../src/worker/ai/subscriptionSeats";
import { handleInboundEmail } from "../src/worker/effects/inboundEmail";
import { handleRequest } from "../src/worker/index";
import { chiefCoverageAllows, handleOperatingControl, operatingStopped } from "../src/worker/services/chiefControls";
import type { Env } from "../src/worker/env";
import { runDueJobs } from "../src/worker/services/jobs";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";

const owner = PARTNERS.find((p) => p.firstName === "Sequoia")!;
const scooter = PARTNERS.find((p) => p.firstName === "Scooter")!;
let testDb: TestDb;
let env: ReturnType<typeof makeTestEnv>;

it("rejects an unconfirmed pause before touching storage", async () => {
  const unopened: Env = {
    WP_OS_ENV: "local",
    get WP_OS_DB(): never { throw new Error("Unconfirmed pause reached the database"); },
    get ASSETS(): never { throw new Error("Pause requested static assets"); },
  };
  const response = await handleOperatingControl({
    env: unopened,
    identity: { id: owner.firmUserId, email: owner.email, fullName: "Fixture owner", roles: ["MANAGING_PARTNER"], status: "ACTIVE", authorityScopes: [] },
    params: {},
    request: new Request("https://fixture.example/api/workforce/operating-control", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify("pause"),
    }),
  });
  expect(response.status).toBe(400);
});

function email(words: string, { partner = owner, pass = true, thread = false, subject = "Fixture command", authserv = "mx.cloudflare.net" } = {}) {
  const address = partner.email;
  const domain = address.split("@")[1];
  const verdict = pass
    ? `${authserv}; spf=pass smtp.mailfrom=${address}; dkim=pass header.d=${domain}; dmarc=pass header.from=${domain}`
    : "mx.cloudflare.net; spf=fail; dkim=fail; dmarc=fail";
  const headers = new Headers({ from: address, subject, "authentication-results": verdict, "message-id": `<${crypto.randomUUID()}@example.test>` });
  if (thread) headers.set("in-reply-to", "<forwarded@example.test>");
  const raw = new Blob([`From: ${address}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${words}`]);
  return handleInboundEmail({ from: address, to: "os@example.test", headers, raw: raw.stream(), rawSize: raw.size }, env);
}

function page(user: string, command?: string, contentType = "application/json") {
  return handleRequest(new Request("https://fixture.example/api/workforce/operating-control", {
    headers: { "x-wpos-dev-user": user, "content-type": contentType },
    method: command === undefined ? "GET" : "POST",
    body: command === undefined ? undefined : JSON.stringify(command),
  }), env);
}

describe("West Peek operating controls", () => {
  beforeAll(async () => {
    testDb = await createTestDb();
    env = makeTestEnv(testDb.db, { WP_OS_DOCUMENTS: testDb.docs });
  });
  afterAll(async () => { if (testDb) await disposeTestDb(testDb); });

  it("pauses through confirmed owner action and invalidates a claimed lease even across a fast resume", async () => {
    const input = { seat: "claude_code" as const, purpose: "Fixture answer", prompt: "Fixture", modelAccess: "PUBLIC_MODEL_APPROVED" };
    const active = await parkRun(env, input);
    expect((await claimRun(env, "fixture", ["claude_code"]))?.id).toBe(active);
    const next = await parkRun(env, input);
    expect((await page(scooter.email, "pause-confirmed")).status).toBe(404);
    expect((await page(owner.email, "pause")).status).toBe(400);
    expect(await operatingStopped(env)).toBe(false);

    expect((await page(owner.email, "pause-confirmed", "text/plain")).status).toBe(415);
    expect((await page(owner.email, "pause-confirmed")).status).toBe(200);
    expect((await page(owner.email, "pause")).status).toBe(400);
    expect(await operatingStopped(env)).toBe(true);
    expect(await claimRun(env, "fixture", ["claude_code"])).toBeNull();
    expect(await runDueJobs(env, new Date())).toEqual([]);
    expect((await page(owner.email, "resume")).status).toBe(200);
    expect((await progressRun(env, { runId: active, deviceId: "fixture" })).accepted).toBe(false);
    expect((await reportRun(env, { runId: active, deviceId: "fixture", outputText: "stale result" })).accepted).toBe(false);
    expect((await claimRun(env, "fixture", ["claude_code"]))?.id).toBe(next);
  });

  it("keeps a credential-shaped chief report out of stored output", async () => {
    const id = await parkRun(env, {
      seat: "claude_code", purpose: "Fixture chief reply", prompt: "Fixture", modelAccess: "PUBLIC_MODEL_APPROVED",
      taskClass: "partner-session",
    });
    await env.WP_OS_DB.prepare("UPDATE subscription_seat_run SET status = 'CLAIMED', claimed_by = 'fixture' WHERE id = ?1").bind(id).run();
    await reportRun(env, { runId: id, deviceId: "fixture", outputText: JSON.stringify({
      phase: "SESSION", status: "ok", asks: [{ words: "Fixture", status: "DONE", why: "Fixture" }],
      reply: "secret = fixtureDemoValue1234",
    }) });
    const row = await env.WP_OS_DB.prepare("SELECT status, output_text, error FROM subscription_seat_run WHERE id = ?1").bind(id).first();
    expect(row).toEqual({ status: "FAILED", output_text: null, error: "The chief report contained material that could not be shared." });
  });

  it("only honours direct authenticated owner commands, and applies and expires a mail-only cover", async () => {
    await email("stop everything", { pass: false });
    await email("stop everything", { authserv: "mx.cloudflare.net.example.test" });
    expect(await operatingStopped(env)).toBe(false);
    await email("stop everything");
    expect(await operatingStopped(env)).toBe(true);
    await email("resume", { partner: scooter });
    expect(await operatingStopped(env)).toBe(true);
    await email("resume");
    expect(await operatingStopped(env)).toBe(false);

    expect(await chiefCoverageAllows(env, "aie_wren", "mail", owner.email)).toBe(false);
    expect(await chiefCoverageAllows(env, "aie_wren", "calendar", owner.email)).toBe(true);
    expect(await chiefCoverageAllows(env, "aie_wren", "drive", owner.email)).toBe(true);
    const cover = JSON.stringify({ operation: "cover_mailbox", mailbox: owner.email });
    await email(cover, { subject: "Fwd: Fixture command" });
    await email(cover, { thread: true });
    expect(await chiefCoverageAllows(env, "aie_wren", "mail", owner.email)).toBe(false);
    await email(cover);
    expect(await chiefCoverageAllows(env, "aie_wren", "mail", owner.email)).toBe(true);
    expect(await chiefCoverageAllows(env, "aie_wren", "mail", owner.email, Date.now() + 3 * 86_400_000)).toBe(false);
  });
});
