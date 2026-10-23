import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { handleRequest } from "../src/worker/index";
import type { Env } from "../src/worker/env";
import { executeExternalEffect } from "../src/worker/effects/executor";
import { outsideEmailAllowed } from "../src/worker/services/outsideEmail";
import {
  OUTSIDE_EMAIL_JOBS,
  OUTWARD_SEND_PATHS,
  TLC_BRAND_SALES_JOB,
  decideOutsideEmail,
  readMode,
  type OutsideEmailState,
} from "../src/shared/policy/outsideEmail";

/**
 * OUTSIDE EMAIL: WHAT MAY SEND (owner, 23 Oct 2026): "We need a universal narrow switch and i can
 * easily go in the ui and tell it which jobs or work cards to allow".
 */

const none = (): OutsideEmailState => ({ breakGlass: false, mode: "ONLY_ALLOWED", allowedJobs: new Set(), allowedCards: new Set() });

describe("one decision", () => {
  it("denies by default: an empty list allows nothing, a request tied to nothing is refused", () => {
    expect(decideOutsideEmail(none(), { job: TLC_BRAND_SALES_JOB })).toEqual({ allowed: false, code: "NOT_ON_LIST", reason: "TLC brand sales is not on your Outside email list." });
    expect(decideOutsideEmail(none(), { cardId: "wc_1" }).allowed).toBe(false);
    expect(decideOutsideEmail(none(), {}).allowed).toBe(false);
    expect(decideOutsideEmail({ ...none(), allowedJobs: new Set(["not_a_job"]) }, { job: "not_a_job" }).allowed).toBe(false);
  });

  it("allows exactly the job or card on the list, and nothing next to it", () => {
    const s = { ...none(), allowedJobs: new Set([TLC_BRAND_SALES_JOB]), allowedCards: new Set(["wc_1"]) };
    expect(decideOutsideEmail(s, { job: TLC_BRAND_SALES_JOB })).toMatchObject({ allowed: true, code: "ALLOWED" });
    expect(decideOutsideEmail(s, { cardId: "wc_1" }).allowed).toBe(true);
    expect(decideOutsideEmail(s, { cardId: "wc_2" }).allowed).toBe(false);
  });

  it("the master switch Off beats the list, and there is no 'everything'", () => {
    const s = { ...none(), mode: "OFF" as const, allowedJobs: new Set([TLC_BRAND_SALES_JOB]) };
    expect(decideOutsideEmail(s, { job: TLC_BRAND_SALES_JOB })).toMatchObject({ allowed: false, code: "MODE_OFF" });
    for (const raw of [null, undefined, "", "EVERYTHING", "ALL", "only_allowed"]) expect(readMode(raw)).toBe("OFF");
    expect(readMode("ONLY_ALLOWED")).toBe("ONLY_ALLOWED");
  });

  it("break-glass wins over everything", () => {
    const s = { ...none(), breakGlass: true, allowedJobs: new Set([TLC_BRAND_SALES_JOB]), allowedCards: new Set(["wc_1"]) };
    expect(decideOutsideEmail(s, { job: TLC_BRAND_SALES_JOB })).toMatchObject({ allowed: false, code: "BREAK_GLASS" });
    expect(decideOutsideEmail(s, { cardId: "wc_1" }).allowed).toBe(false);
  });

  it("every job on the list says, in plain words, what it sends and to whom", () => {
    expect(OUTSIDE_EMAIL_JOBS.map((j) => j.id)).toContain(TLC_BRAND_SALES_JOB);
    for (const j of OUTSIDE_EMAIL_JOBS) for (const k of ["name", "employee", "sends", "to", "stillNeeds"] as const) expect(j[k].length).toBeGreaterThan(3);
  });
});

describe("the allowlist decides for every send path", () => {
  const ROOT = path.resolve(__dirname, "..");
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(d, e.name)] : []));
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const files = walk(path.join(ROOT, "src")).map((f) => ({ rel: path.relative(ROOT, f).split(path.sep).join("/"), body: strip(readFileSync(f, "utf8")) }));
  const SENDS = /\b(sendViaResend|sendViaCloudflare|sendViaGmail)\s*\(|api\.resend\.com|gmail\/v1\/users\/me\/messages\/send/;

  it("enumerates every transport call site, and each one is registered with its reason", () => {
    const senders = files.filter((f) => SENDS.test(f.body)).map((f) => f.rel).sort();
    expect(senders.length).toBeGreaterThanOrEqual(5);
    // A new sender that is not registered makes these two lists differ, and this fails.
    expect(senders).toEqual(OUTWARD_SEND_PATHS.map((p) => p.file).sort());
  });

  it("every GOVERNED path asks outsideEmailAllowed before it sends, and nobody else reads the list", () => {
    const governed = OUTWARD_SEND_PATHS.filter((p) => p.kind === "GOVERNED");
    expect(governed.length).toBeGreaterThan(0);
    for (const g of governed) {
      const body = files.find((f) => f.rel === g.file)!.body;
      expect(body.indexOf("outsideEmailAllowed(")).toBeGreaterThan(-1);
      expect(body.indexOf("outsideEmailAllowed(")).toBeLessThan(body.indexOf("performEffect(env, request)"));
    }
    const readers = files.filter((f) => /WP_OS_OUTSIDE_EMAIL_BREAK_GLASS|BREAK_GLASS_VAR|outside_email_allow\b|outside_email_mode\b|WP_OS_AI_EMAIL_EXTERNAL/.test(f.body)).map((f) => f.rel).sort();
    expect(readers).toEqual(["src/shared/policy/outsideEmail.ts", "src/worker/env.ts", "src/worker/services/outsideEmail.ts"]);
  });
});

describe("her list in D1: Allow and Stop, with audit", () => {
  let t: TestDb;
  let env: Env;
  const MP = { "x-wpos-dev-user": "sequoia@westpeek.ventures" };
  const MEMBER = { "x-wpos-dev-user": "outside-member@westpeek.ventures" };
  const call = async (p: string, headers: Record<string, string>, method = "GET", body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await handleRequest(new Request(`https://test.local${p}`, { method, headers: body === undefined ? headers : { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }), env);
    return { status: res.status, body: await res.json() };
  };
  const AI = { type: "AI" as const, aiEmployeeId: "aie_wynn", roles: [], firmScopes: ["west-peek"] };
  const fileEmail = async (id: string, job: string | null, card: string | null = null) =>
    env.WP_OS_DB.prepare("INSERT INTO external_effect_request (id, effect_type, destination, payload_json, requested_by_type, requested_by_id, outside_job, work_card_id) VALUES (?1, 'email.send', 'ana@brand.example', '{}', 'AI', 'aie_wynn', ?2, ?3)").bind(id, job, card).run();
  const refusal = async (id: string): Promise<string> => {
    try {
      await executeExternalEffect(env, AI, id, "apc_none");
      return "sent";
    } catch (err) {
      return (err as { code?: string }).code ?? String(err);
    }
  };

  beforeAll(async () => {
    t = await createTestDb();
    env = makeTestEnv(t.db);
    await t.db.prepare("INSERT INTO firm_user (id, email, full_name, status) VALUES ('fu_outside_member', 'outside-member@westpeek.ventures', 'Outside Member', 'ACTIVE')").run();
    await t.db.prepare("INSERT INTO firm_user_role (firm_user_id, role_id) VALUES ('fu_outside_member', 'role_investment_team')").run();
  });
  afterAll(async () => disposeTestDb(t));

  it("after the migration: Only what I allow, nothing on the list, nothing allowed", async () => {
    const s = await call("/api/outside-email", MP);
    expect(s.status).toBe(200);
    expect(s.body.mode).toBe("ONLY_ALLOWED");
    expect(s.body.break_glass).toBe(false);
    expect(s.body.jobs.map((j: { id: string; allowed: boolean }) => [j.id, j.allowed])).toEqual([[TLC_BRAND_SALES_JOB, false]]);
    expect(s.body.cards).toEqual([]);
    expect((await outsideEmailAllowed(env, { job: TLC_BRAND_SALES_JOB })).allowed).toBe(false);
    // The executor refuses an employee's outside email before any approval is even looked at.
    await fileEmail("eer_out_1", TLC_BRAND_SALES_JOB);
    expect(await refusal("eer_out_1")).toBe("ai_email_disabled");
  });

  it("only a Managing Partner changes it; no third mode; no unknown job", async () => {
    expect((await call("/api/outside-email", MEMBER)).status).toBe(403);
    expect((await call("/api/outside-email/allow", MEMBER, "POST", { item_type: "JOB", item_id: TLC_BRAND_SALES_JOB, allowed: true })).status).toBe(403);
    expect((await call("/api/outside-email/mode", MP, "POST", { mode: "EVERYTHING" })).status).toBe(400);
    expect((await call("/api/outside-email/allow", MP, "POST", { item_type: "JOB", item_id: "mass_mail", allowed: true })).status).toBe(400);
    expect((await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM outside_email_audit").first<{ n: number }>())!.n).toBe(0);
  });

  it("Allow puts the job on the list with who and when, and the executor lets it past the list (the receipt still decides)", async () => {
    const r = await call("/api/outside-email/allow", MP, "POST", { item_type: "JOB", item_id: TLC_BRAND_SALES_JOB, allowed: true });
    expect(r.status).toBe(200);
    const job = r.body.jobs.find((j: { id: string }) => j.id === TLC_BRAND_SALES_JOB);
    expect(job).toMatchObject({ allowed: true, sending_now: true });
    expect(job.changed_by).toBeTruthy();
    expect(job.changed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(r.body.audit[0]).toMatchObject({ item_type: "JOB", item_id: TLC_BRAND_SALES_JOB, action: "ALLOW", changed_by: job.changed_by });
    expect((await outsideEmailAllowed(env, { job: TLC_BRAND_SALES_JOB })).allowed).toBe(true);
    // Past the list, the approval receipt is still required: allowing sends nothing by itself.
    expect(await refusal("eer_out_1")).toBe("authorization_required");
    // A different job, or none, is still refused.
    await fileEmail("eer_out_2", null);
    expect(await refusal("eer_out_2")).toBe("ai_email_disabled");
  });

  it("break-glass wins over her list", async () => {
    const glass = makeTestEnv(t.db, { WP_OS_OUTSIDE_EMAIL_BREAK_GLASS: "off-hard" } as Partial<Env>);
    expect(await outsideEmailAllowed(glass, { job: TLC_BRAND_SALES_JOB })).toMatchObject({ allowed: false, code: "BREAK_GLASS" });
    await expect(executeExternalEffect(glass, AI, "eer_out_1", "apc_none")).rejects.toMatchObject({ code: "ai_email_disabled" });
  });

  it("a card is allowed from the card, shows on the same list, and Stop is audited too", async () => {
    await env.WP_OS_DB.prepare("INSERT INTO work_card (id, title, created_by) VALUES ('wc_outside_1', 'Email the venue', 'fu_sequoia_taylor')").run();
    const card = await env.WP_OS_DB.prepare("SELECT id FROM work_card WHERE id = 'wc_outside_1'").first<{ id: string }>();
    expect(card?.id).toBe("wc_outside_1");
    expect((await call("/api/outside-email/cards/wc_outside_1", MP)).body).toMatchObject({ allowed: false, sending_now: false });
    const a = await call("/api/outside-email/allow", MP, "POST", { item_type: "CARD", item_id: "wc_outside_1", allowed: true });
    expect(a.body.cards).toEqual([expect.objectContaining({ id: "wc_outside_1", title: "Email the venue", allowed: true })]);
    await fileEmail("eer_out_3", null, "wc_outside_1");
    expect(await refusal("eer_out_3")).toBe("authorization_required");

    const stop = await call("/api/outside-email/allow", MP, "POST", { item_type: "CARD", item_id: "wc_outside_1", allowed: false });
    expect(stop.body.cards[0].allowed).toBe(false);
    expect(await refusal("eer_out_3")).toBe("ai_email_disabled");
    const audit = (await env.WP_OS_DB.prepare("SELECT item_type, item_id, action FROM outside_email_audit ORDER BY changed_at, rowid").all<{ item_type: string; item_id: string; action: string }>()).results!;
    expect(audit.map((r) => `${r.item_type}:${r.item_id}:${r.action}`)).toEqual([`JOB:${TLC_BRAND_SALES_JOB}:ALLOW`, "CARD:wc_outside_1:ALLOW", "CARD:wc_outside_1:STOP"]);
    expect((await call("/api/outside-email/allow", MP, "POST", { item_type: "CARD", item_id: "wc_nope", allowed: true })).status).toBe(404);
  });

  it("the master switch Off stops an allowed job, is audited, and back to Only what I allow restores it", async () => {
    const off = await call("/api/outside-email/mode", MP, "POST", { mode: "OFF" });
    expect(off.body.mode).toBe("OFF");
    expect((await outsideEmailAllowed(env, { job: TLC_BRAND_SALES_JOB })).allowed).toBe(false);
    const back = await call("/api/outside-email/mode", MP, "POST", { mode: "ONLY_ALLOWED" });
    expect(back.body.audit.slice(0, 2).map((r: { action: string }) => r.action)).toEqual(["MODE_ONLY_ALLOWED", "MODE_OFF"]);
    expect((await outsideEmailAllowed(env, { job: TLC_BRAND_SALES_JOB })).allowed).toBe(true);
  });
});
