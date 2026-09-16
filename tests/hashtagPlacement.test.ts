import { describe, expect, it } from "vitest";
import { classifyInbound, personFromMessage } from "../src/worker/effects/inboundEmail";
import { dealFromMessage } from "../src/worker/services/dealIntake";

/**
 * Owner, 16 Sep 2026: "make sure it works with both hashtags, in subject and/or in body."
 * The trigger, the company for #wpdealflow and the person for #wpnetwork must be read whichever
 * place the tag sits — and a generic subject must not become the company name.
 */
const cases = [
  { name: "tag in subject", subject: "#wpdealflow Northwind Robotics", body: "Met them at the summit. Deck attached." },
  { name: "tag in body, company on a line", subject: "Northwind intro", body: "Forwarding this.\n#wpdealflow\nCompany: Northwind Robotics\nSector: robotics" },
  { name: "tag in subject and body, uppercase", subject: "#WPDEALFLOW Northwind Robotics", body: "#WpDealFlow — see attached" },
];

describe("#wpdealflow is read from subject and/or body", () => {
  for (const c of cases) {
    it(c.name, () => {
      const summary = classifyInbound({ to: "os@joinwestpeek.com", from: "sequoia@westpeek.ventures", subject: c.subject, body: c.body });
      expect(summary.triggers).toContain("#wpdealflow");
      const deal = dealFromMessage(summary.subject, c.body, "sequoia@westpeek.ventures", false);
      expect(deal?.company).toBe("Northwind Robotics");
    });
  }
  it("an untagged subject is offered as the company but FLAGGED, so the handler accepts it only when the register knows it", () => {
    const forward = dealFromMessage("Fwd: Northwind Robotics", "thoughts?\n\n#wpdealflow", "sequoia@westpeek.ventures", false);
    expect(forward).toMatchObject({ company: "Northwind Robotics", subjectUntagged: true });
    const generic = dealFromMessage("check this out", "#wpdealflow\nlooks interesting", "sequoia@westpeek.ventures", false);
    expect(generic).toMatchObject({ company: "check this out", subjectUntagged: true });
    const tagged = dealFromMessage("#wpdealflow check this out", "hi", "sequoia@westpeek.ventures", false);
    expect(tagged).toMatchObject({ company: "check this out", subjectUntagged: false });
    const named = dealFromMessage("check this out", "#wpdealflow\nCompany: Northwind Robotics", "sequoia@westpeek.ventures", false);
    expect(named).toMatchObject({ company: "Northwind Robotics", subjectUntagged: false });
  });
});

describe("#wpnetwork is read from subject and/or body", () => {
  const person = "Name: Test Person\nCompany: Example Co\nTitle: Founder\nEmail: test.person@example.com";
  for (const c of [
    { name: "tag in subject", subject: "#wpnetwork", body: person },
    { name: "tag in body", subject: "Someone you should know", body: `#wpnetwork\n${person}` },
    { name: "tag in subject, uppercase, person in body", subject: "#WPNETWORK Test Person", body: person },
  ]) {
    it(c.name, () => {
      const summary = classifyInbound({ to: "os@joinwestpeek.com", from: "sequoia@westpeek.ventures", subject: c.subject, body: c.body });
      expect(summary.triggers).toContain("#wpnetwork");
      const p = personFromMessage("sequoia@westpeek.ventures", c.body);
      expect(p).toMatchObject({ name: "Test Person", email: "test.person@example.com", company: "Example Co" });
    });
  }
  it("a #wpnetwork mail with only a name in the subject still proposes that person", () => {
    const p = personFromMessage("sequoia@westpeek.ventures", "great founder, met last week", "#wpnetwork Test Person");
    expect(p).toMatchObject({ name: "Test Person", email: "sequoia@westpeek.ventures" });
    // A sentence is not a name.
    expect(personFromMessage("sequoia@westpeek.ventures", "hi", "#wpnetwork someone you should really meet soon")).toBeNull();
  });
});

// ── Through the real handler with a real D1 ──
import { afterAll, beforeAll, vi } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { handleInboundEmail } from "../src/worker/effects/inboundEmail";
import { TRUSTED_AUTHSERV_ID } from "../src/shared/intake/partnerAuthority";
import { INTAKE_MAILBOX, ROUTING_EMPLOYEE } from "../src/shared/intake/emailTriggers";
import type { Env } from "../src/worker/env";

let t: TestDb;
let env: Env;
const genuineFrom = (address: string): string =>
  `${TRUSTED_AUTHSERV_ID}; dkim=pass header.d=westpeek-ventures.20251104.gappssmtp.com header.s=20251104; dmarc=none header.from=westpeek.ventures policy.dmarc=none; spf=pass (${TRUSTED_AUTHSERV_ID}: domain of ${address} designates 2607:f8b0:4864:20::f2e as permitted sender) smtp.mailfrom=${address}; arc=none`;

function deliver(subject: string, body: string): Promise<void> {
  const bytes = new TextEncoder().encode(body);
  const headers = new Headers({ from: "Sequoia Taylor <sequoia@westpeek.ventures>", subject, "authentication-results": genuineFrom("sequoia@westpeek.ventures") });
  return handleInboundEmail({ from: "sequoia@westpeek.ventures", to: INTAKE_MAILBOX, headers, raw: new Blob([bytes]).stream(), rawSize: bytes.byteLength }, env);
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db, { WP_OS_NETWORK_OS_BASE_URL: "https://network.example", WP_OS_NETWORK_OS_SESSION_SECRET: "test-secret-for-the-unit-test-only", WP_OS_NETWORK_OS_USER_EMAIL: "os@westpeek.ventures" });
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
});
afterAll(async () => { vi.unstubAllGlobals(); await disposeTestDb(t); });

describe("through the handler: where each placement lands", () => {
  it("tag in the subject → the company enters the funnel", async () => {
    await deliver("#wpdealflow Northwind Robotics", "met them at the summit");
    const co = await env.WP_OS_DB.prepare("SELECT canonical_name FROM canonical_company WHERE canonical_name LIKE 'Northwind%'").first<{ canonical_name: string }>();
    expect(co?.canonical_name).toBe("Northwind Robotics");
  });
  it("tag in the body, generic subject → Porter's routing card, not a company called 'check this out'", async () => {
    await deliver("check this out", "#wpdealflow\nlooks interesting");
    const junk = await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM canonical_company WHERE lower(canonical_name) = 'check this out'").first<{ n: number }>();
    expect(junk?.n).toBe(0);
    const porter = await env.WP_OS_DB.prepare("SELECT title FROM work_card WHERE owner_id = ?1 AND state != 'CANCELLED' ORDER BY created_at DESC LIMIT 1").bind(`aie_${ROUTING_EMPLOYEE.toLowerCase()}`).first<{ title: string }>();
    expect(porter?.title ?? "").toMatch(/check this out|could not be read|Tagged for deal flow/i);
  });
  it("tag in the body, forwarded subject naming a KNOWN company → goes through to that company", async () => {
    await deliver("Fwd: Northwind Robotics", "thoughts?\n\n#wpdealflow");
    const n = await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM canonical_company WHERE canonical_name LIKE 'Northwind%'").first<{ n: number }>();
    expect(n?.n).toBe(1); // matched, not duplicated
  });
  it("#wpnetwork with the name in the subject only → the person is proposed to Network OS", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => { calls.push(`${String(url)} ${init?.body ?? ""}`); return new Response(JSON.stringify({ ok: true, id: "x" }), { status: 200 }); });
    await deliver("#wpnetwork Test Person", "great founder, met last week");
    expect(calls.some((c) => /Test Person/.test(c))).toBe(true);
  });
});
