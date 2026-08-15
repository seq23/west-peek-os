import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { handleRequest } from "../src/worker/index";
import type { Env } from "../src/worker/env";
import { createSpecialistAdapter } from "../src/worker/ai/providers/specialist";

/**
 * P22–P24 — connector status, the specialist provider lane, and the LP operating surface
 * (GAP-16, GAP-17, GAP-15, GAP-18).
 *
 * The common thread: these are the phases where it would be easiest to *look* integrated. Every
 * test here exists to make sure the product says what is actually true.
 *
 * - A connector row is configuration. A check is LOCAL_FIXTURE and says it contacted nothing.
 * - Network OS remains authoritative; this surface performs no external write at all.
 * - The meeting prep queue reports consent and recording-policy state as facts from P7.
 * - A specialist vendor is a provider behind run_ai(): default-deny egress blocks it, and even
 *   with an allowance the adapter fails closed with a named reason.
 * - Specialist output is an INPUT, never a conclusion; the table has no conclusion column.
 * - An administrator source cannot be marked LIVE by hand, and freshness is computed.
 */

let t: TestDb;
let env: Env;

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };
const MEMBER = { "x-wpos-dev-user": "member@westpeek.ventures" };

function req(path: string, headers: Record<string, string> = {}, method = "GET", body?: unknown): Request {
  return new Request(`https://test.local${path}`, {
    method,
    headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function call<T = any>(path: string, headers: Record<string, string>, method = "GET", body?: unknown): Promise<{ status: number; body: T }> {
  const res = await handleRequest(req(path, headers, method, body), env);
  return { status: res.status, body: (await res.json()) as T };
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
  await t.db
    .prepare("INSERT INTO firm_user (id, email, full_name, status) VALUES ('fu_test_member', 'member@westpeek.ventures', 'Test Member', 'ACTIVE')")
    .run();
  await t.db.prepare("INSERT INTO firm_user_role (firm_user_id, role_id) VALUES ('fu_test_member', 'role_investment_team')").run();
});

afterAll(async () => {
  await disposeTestDb(t);
});

describe("P22 — connectors are configuration, not integration", () => {
  it("registers all six external systems as NOT_CONFIGURED with their gate named", async () => {
    const res = await call<{ connectors: any[]; network_os: any; rules: Record<string, string> }>("/api/connectors", MP);
    expect(res.status).toBe(200);
    expect(res.body.connectors).toHaveLength(6);
    for (const c of res.body.connectors) {
      expect(c.status).toBe("NOT_CONFIGURED");
      expect(c.credential_configured).toBe(false);
    }
    const transcription = res.body.connectors.find((c: any) => c.connector_key === "transcription")!;
    expect(transcription.consent_required).toBe(1);
    expect(transcription.approval_gate).toContain("consent is a second, independent gate");
    expect(res.body.rules.writes).toContain("no external writes");
  });

  it("preserves Network OS authority and reports its P9 facts rather than a mirror", async () => {
    const res = await call<{ network_os: { authority: string; contract_declared: boolean; open_conflicts: number } }>("/api/connectors", MP);
    expect(res.body.network_os.authority).toContain("never overwrites it");
    expect(res.body.network_os.contract_declared).toBe(false);
    expect(res.body.network_os.open_conflicts).toBe(0);
  });

  it("runs a LOCAL_FIXTURE check that names every missing precondition and contacts nothing", async () => {
    const res = await call<{ mode: string; ok: boolean; problems: string[]; detail: string }>("/api/connectors/network_os/check", MP, "POST");
    expect(res.status).toBe(201);
    expect(res.body.mode).toBe("LOCAL_FIXTURE");
    expect(res.body.ok).toBe(false);
    expect(res.body.problems.join(" ")).toContain("NETWORK_OS_API_TOKEN is not populated");
    expect(res.body.problems.join(" ")).toContain("no adapter contract has been declared");
    expect(res.body.detail).toContain("Nothing was contacted");

    const check = await t.db.prepare("SELECT mode FROM connector_check ORDER BY created_at DESC LIMIT 1").first<{ mode: string }>();
    expect(check!.mode).toBe("LOCAL_FIXTURE");
  });

  it("reports meeting prep and consent state as facts from the P7 substrate", async () => {
    const future = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const meeting = await call<{ id: string }>("/api/meetings", MP, "POST", {
      title: "Founder intro",
      meeting_type: "FOUNDER",
      scheduled_at: future,
    });
    expect(meeting.status).toBe(201);

    const queue = await call<{ queue: any[]; note: string; transcription_connector: { status: string } }>("/api/meeting-prep/queue", MP);
    const row = queue.body.queue.find((m: any) => m.id === meeting.body.id)!;
    expect(row.needs_prep).toBe(true);
    expect(row.recording_state).toContain("no recording policy activated");
    expect(queue.body.note).toContain("No calendar is connected");
    expect(queue.body.transcription_connector.status).toBe("NOT_CONFIGURED");
  });
});

describe("P23 — a specialist vendor is a provider, not a bypass", () => {
  it("registers Harvey and Norm disabled, unpriced, and with NO data class allowed to egress", async () => {
    const res = await call<{ providers: any[]; status: string; gate_detail: string }>("/api/specialist/engagements", MP);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("UNPROVEN — VENDOR ACCESS GATE");
    expect(res.body.gate_detail).toContain("have never been called");
    for (const p of res.body.providers) {
      expect(p.enabled).toBe(0);
      expect(p.allowed_labels).toBe(0);
      expect(p.credential_configured).toBe(false);
      expect(p.endpoint_known).toBe(false);
    }
  });

  it("the specialist adapter fails closed before any network attempt", async () => {
    let called = false;
    const noEndpoint = createSpecialistAdapter({
      vendor: "harvey",
      baseUrl: null,
      model: "harvey-default",
      apiKey: "would-be-a-key",
      fetchImpl: (async () => {
        called = true;
        return new Response("{}");
      }) as unknown as typeof fetch,
    });
    await expect(noEndpoint.complete({ purpose: "p", inputs: ["i"], model: null })).rejects.toThrow("vendor_endpoint_unknown:harvey");

    const noCredential = createSpecialistAdapter({
      vendor: "norm",
      baseUrl: "https://vendor.invalid",
      model: "norm-default",
      fetchImpl: (async () => {
        called = true;
        return new Response("{}");
      }) as unknown as typeof fetch,
    });
    await expect(noCredential.complete({ purpose: "p", inputs: ["i"], model: null })).rejects.toThrow("credential_missing:norm");
    expect(called).toBe(false);
  });

  it("an engagement runs through run_ai and is BLOCKED by the provider gates, with the reason recorded", async () => {
    // FRONTIER so the external path is taken; Harvey is disabled and allowed no data class.
    await t.db
      .prepare(
        `INSERT INTO budget_policy (id, firm_scope, cost_mode, privacy_mode, daily_cap_usd, per_run_cap_usd, set_by)
         VALUES (?1, 'west-peek', 'NORMAL', 'FRONTIER', 25.0, 2.0, 'fu_scooter_taylor')`,
      )
      .bind(`bp_${crypto.randomUUID()}`)
      .run();

    const res = await call<{ engagement: { status: string; block_reason: string; ai_run_id: string }; run: { status: string }; boundary: string }>(
      "/api/specialist/engagements",
      MP,
      "POST",
      {
        provider_key: "harvey",
        matter_type: "LEGAL_RESEARCH",
        question: "What disclosure applies to a secondary purchase from a former employee?",
        data_class: "CONFIDENTIAL",
      },
    );
    expect(res.status).toBe(201);
    expect(res.body.engagement.status).toBe("BLOCKED");
    expect(res.body.engagement.block_reason).toContain("provider_disabled:harvey");
    expect(res.body.boundary).toContain("never issues a legal or compliance conclusion");

    // The run is in the ordinary ai_run ledger — one boundary, one ledger.
    const run = await t.db.prepare("SELECT id, purpose FROM ai_run WHERE id = ?1").bind(res.body.engagement.ai_run_id).first<{ purpose: string }>();
    expect(run!.purpose).toContain("specialist harvey");
  });

  it("still refuses to egress after the vendor is enabled, because no data class is allowed", async () => {
    await t.db.prepare("UPDATE provider_registry SET enabled = 1 WHERE provider_key = 'norm'").run();
    const res = await call<{ engagement: { status: string; block_reason: string } }>("/api/specialist/engagements", MP, "POST", {
      provider_key: "norm",
      matter_type: "COMPLIANCE_REVIEW",
      question: "Does this LP communication need compliance review?",
      data_class: "CONFIDENTIAL",
    });
    expect(res.body.engagement.status).toBe("BLOCKED");
    expect(res.body.engagement.block_reason).toContain("data_policy_denies_label:CONFIDENTIAL");
  });

  it("cannot record a conclusion: the table has no column for one", async () => {
    const cols = await t.db.prepare("PRAGMA table_info(specialist_engagement)").all<{ name: string }>();
    const names = (cols.results ?? []).map((c) => c.name);
    expect(names).toContain("disposition_note");
    for (const banned of ["conclusion", "legal_opinion", "advice", "determination"]) {
      expect(names).not.toContain(banned);
    }
  });

  it("refuses to accept an output that never came back", async () => {
    const blocked = await t.db.prepare("SELECT id FROM specialist_engagement WHERE status = 'BLOCKED' LIMIT 1").first<{ id: string }>();
    const res = await call(`/api/specialist/engagements/${blocked!.id}/accept`, MP, "POST", { disposition_note: "looks fine" });
    expect(res.status).toBe(409);
    expect((res.body as any).error).toBe("nothing_to_accept");
  });
});

describe("P24 — the LP operating surface reports gates, not intentions", () => {
  it("ships both administrator sources with NO_CONTRACT and a computed freshness", async () => {
    const res = await call<{ sources: any[]; gates: Record<string, string>; authority: string }>("/api/lp-ops/overview", MP);
    expect(res.status).toBe(200);
    const admin = res.body.sources.find((s: any) => s.source_key === "fund_administrator")!;
    expect(admin.contract_state).toBe("NO_CONTRACT");
    expect(admin.freshness).toContain("NEVER_IMPORTED");
    expect(res.body.gates.fund_admin).toContain("SOURCE CONTRACT GATE");
    expect(res.body.gates.vdr).toContain("PROVIDER NOT SELECTED");
    expect(res.body.authority).toContain("never overwrites an administrator figure");
  });

  it("refuses the whole surface to a user without LP_PRIVATE scope rather than showing an empty page", async () => {
    const res = await call("/api/lp-ops/overview", MEMBER);
    expect(res.status).toBe(403);
  });

  it("will not let a source be declared LIVE by hand", async () => {
    const res = await call("/api/lp-ops/sources", MP, "POST", {
      source_key: "fund_administrator",
      name: "Administrator",
      kind: "FUND_ADMIN",
      contract_state: "LIVE",
    });
    expect(res.status).toBe(400);

    const agreed = await call<{ source: { contract_state: string }; note: string }>("/api/lp-ops/sources", MP, "POST", {
      source_key: "fund_administrator",
      name: "Administrator of record",
      kind: "FUND_ADMIN",
      contract_state: "FORMAT_AGREED",
      export_format: "monthly NAV + capital account CSV",
    });
    expect(agreed.status).toBe(201);
    expect(agreed.body.source.contract_state).toBe("FORMAT_AGREED");
    expect(agreed.body.note).toContain("cannot be set by hand");
  });

  it("requires FORMAT_AGREED to name the format", async () => {
    const res = await call("/api/lp-ops/sources", MP, "POST", {
      source_key: "accounting",
      name: "Accountant",
      kind: "ACCOUNTING",
      contract_state: "FORMAT_AGREED",
    });
    expect(res.status).toBe(400);
    expect((res.body as any).error).toBe("format_required");
  });

  it("schedules reconciliation and says plainly that a schedule is not a source", async () => {
    const fund = await call<{ id: string }>("/api/funds", MP, "POST", { name: "West Peek Fund I", vintage_year: 2026 });
    expect(fund.status).toBe(201);
    const res = await call<{ schedule: { cadence: string; next_due_at: string }; note: string }>(
      "/api/lp-ops/reconciliation-schedules",
      MP,
      "POST",
      { fund_id: fund.body.id, cadence: "QUARTERLY", next_due_at: "2026-09-30T00:00:00.000Z" },
    );
    expect(res.status).toBe(201);
    expect(res.body.schedule.cadence).toBe("QUARTERLY");
    expect(res.body.note).toContain("source contract that does not yet exist");

    const overview = await call<{ reconciliation_schedules: Array<{ due: boolean; days_until_due: number }> }>("/api/lp-ops/overview", MP);
    expect(overview.body.reconciliation_schedules).toHaveLength(1);
  });

  it("tracks LP engagement state with an append-only change log and notifies on AWAITING_DECISION", async () => {
    const lp = await call<{ id: string }>("/api/lp/records", MP, "POST", { legal_name: "Cedar Family Office", lp_type: "FAMILY_OFFICE" });
    expect(lp.status).toBe(201);

    const updated = await call<{ state: string }>(`/api/lp-ops/engagements/${lp.body.id}`, MP, "POST", {
      state: "AWAITING_DECISION",
      next_step: "They asked for the Q2 pack before deciding.",
      note: "moved after the second call",
    });
    expect(updated.status).toBe(200);
    expect(updated.body.state).toBe("AWAITING_DECISION");

    const change = await t.db.prepare("SELECT * FROM lp_engagement_change WHERE lp_record_id = ?1").bind(lp.body.id).first<{ from_state: string; to_state: string; id: string }>();
    expect(change!.from_state).toBe("NOT_ENGAGED");
    expect(change!.to_state).toBe("AWAITING_DECISION");
    await expect(t.db.prepare("UPDATE lp_engagement_change SET note = 'x' WHERE id = ?1").bind(change!.id).run()).rejects.toThrow(/append-only/);

    const notification = await t.db
      .prepare("SELECT kind, privacy_label FROM notification WHERE object_id = ?1")
      .bind(lp.body.id)
      .first<{ kind: string; privacy_label: string }>();
    expect(notification!.kind).toBe("LP_ISSUE");
    expect(notification!.privacy_label).toBe("LP_PRIVATE");
  });
});
