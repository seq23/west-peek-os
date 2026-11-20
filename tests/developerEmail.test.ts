import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { handleRequest } from "../src/worker/index";
import { handleDeveloperEmail } from "../src/worker/services/developerDirection";
import { openAssignmentCard } from "../src/worker/services/dealIntake";
import { EMAILED_TASK_LIMITS } from "../src/shared/intake/partnerAuthority";
// @ts-expect-error — a plain .mjs script, imported for its one pure function
import { tellPartnerRequest } from "../scripts/ops/tell-partner.mjs";

/**
 * THE DEVELOPER'S EMAIL ON ANY JOB, AND "<EMPLOYEE>, TELL <PARTNER>: …" FROM THE MAC (20 Nov 2026, her words: "developer
 * email action — should be for ALL JOBS!" and "i should be able to tell u to tell wesley to message a partner").
 */

let t: TestDb;
let env: Env;
const sent: Array<{ to: string[]; subject: string; text: string; cc: string[] }> = [];
const SCOOTER = "scooter@westpeek.ventures";
const SEQUOIA = "sequoia@westpeek.ventures";
const MAC = { id: "fu_subscription_claimer", email: "subscription-claimer@joinwestpeek.com", fullName: "Mac", status: "ACTIVE", roles: [] as string[], authorityScopes: [] };

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db, { WP_OS_AI_EMAIL_PARTNERS: "enabled", WP_OS_EMAIL_SEND: "enabled", RESEND_API_KEY: "re_test_not_a_real_key", WP_OS_EMAIL_FROM: "os@westpeek.ventures" } as Partial<Env>);
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("api.resend.com")) {
      const body = JSON.parse(String(init?.body)) as { to: string[]; subject: string; text: string; cc?: string[] };
      sent.push({ to: body.to, subject: body.subject, text: body.text, cc: body.cc ?? [] });
      return new Response(JSON.stringify({ id: `re_${sent.length}` }), { status: 200 });
    }
    throw new Error(`unexpected fetch in test: ${String(url)}`);
  });
  await env.WP_OS_DB.prepare("UPDATE ai_employee SET status = 'ACTIVE' WHERE id IN ('aie_wesley', 'aie_walker')").run();
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await disposeTestDb(t);
});

async function sessionCard(id: string, cols: { requested_by_email?: string | null; result_recipient?: string | null }) {
  await env.WP_OS_DB.prepare(
    "INSERT INTO work_card (id, title, state, kind, owner_type, owner_id, created_by, requested_by_email, result_recipient, firm_scope) VALUES (?1, 'LP diligence pack', 'IN_PROGRESS', 'PARTNER_SESSION', 'AI', 'aie_wesley', 'fu_subscription_claimer', ?2, ?3, 'west-peek')",
  ).bind(id, cols.requested_by_email ?? null, cols.result_recipient ?? null).run();
}
const mail = (id: string, subject: string, text: string) =>
  handleDeveloperEmail({ request: new Request(`https://os.joinwestpeek.com/api/work-cards/${id}/developer-email`, { method: "POST", body: JSON.stringify({ subject, text }) }), env, identity: MAC, params: { id } } as never);

describe("the developer's email works on every job, partners only, once", () => {
  it("a PARTNER_SESSION card sends the exact words, as its own employee, to the partner the card names", async () => {
    await sessionCard("wc_dev_session", { result_recipient: SCOOTER });
    const from = sent.length;
    const res = await mail("wc_dev_session", "The diligence pack is ready", "Scooter,\n\nBoth links are on the card.\n\nWesley");
    expect(res.status).toBe(200);
    const mine = sent.slice(from);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.to).toEqual([SCOOTER]);
    expect(mine[0]!.cc).toEqual([]);
    expect(mine[0]!.text).toBe("Scooter,\n\nBoth links are on the card.\n\nWesley");
  });

  it("an address that is not a partner is refused before anything is sent", async () => {
    await sessionCard("wc_dev_outsider", { requested_by_email: "lp@example.org" });
    const from = sent.length;
    const res = await mail("wc_dev_outsider", "Hello", "Words");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { detail: string }).detail).toContain("not one of the two partner addresses");
    expect(sent.length).toBe(from);
  });

  it("the same words twice on one job are refused; a card naming nobody is refused with the reason", async () => {
    await sessionCard("wc_dev_twice", { requested_by_email: SEQUOIA });
    expect((await mail("wc_dev_twice", "Same", "Same words")).status).toBe(200);
    const from = sent.length;
    expect((await mail("wc_dev_twice", "Same", "Same words")).status).toBe(409);
    expect(sent.length).toBe(from);
    await sessionCard("wc_dev_nobody", {});
    expect((await mail("wc_dev_nobody", "Hi", "Words")).status).toBe(409);
  });
});

describe("tell-partner.mjs opens the same PARTNER_MESSAGE the email door makes", () => {
  it("same kind, employee, partner, instruction and title; asked for by the partner the Mac acts for", async () => {
    const SENTENCE = "Wesley, tell Scooter: the questions sheet and the DDQ are ready for Monday.";
    const viaEmail = await openAssignmentCard(env, { subject: "note", partnerAddress: SEQUOIA, chiefOfStaff: "Walker", raw: SENTENCE, limits: EMAILED_TASK_LIMITS, emlKey: null });
    const res = await handleRequest(
      new Request("https://test.local/api/work-cards", { method: "POST", headers: { "x-wpos-dev-user": MAC.email, "content-type": "application/json" }, body: JSON.stringify(tellPartnerRequest(SENTENCE)) }),
      env,
    );
    expect(res.status).toBe(201);
    const viaMac = ((await res.json()) as { id: string }).id;
    const row = (id: string) =>
      env.WP_OS_DB.prepare("SELECT kind, owner_type, owner_id, result_recipient, prompt, title, requested_by_email FROM work_card WHERE id = ?1").bind(id).first<Record<string, string>>();
    const email = await env.WP_OS_DB.prepare("SELECT id FROM work_card WHERE kind = 'PARTNER_MESSAGE' AND result_recipient = ?1 AND id != ?2 ORDER BY created_at DESC").bind(SCOOTER, viaMac).first<{ id: string }>();
    expect(email?.id ?? viaEmail).toBeTruthy();
    expect(await row(viaMac)).toEqual(await row(email!.id));
    expect((await row(viaMac))!.requested_by_email).toBe(SEQUOIA);
  });
});
