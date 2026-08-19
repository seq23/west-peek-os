import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { handleRequest } from "../src/worker/index";
import type { Env } from "../src/worker/env";
import type { Actor } from "../src/worker/services/authorize";
import {
  assessDeterioration,
  decideSupportMatch,
  evaluateCompanyAlerts,
  proposeSupportMatch,
  recordSupportOutcome,
} from "../src/worker/services/portfolio";
import { runAi } from "../src/worker/ai/runAi";

/**
 * P8 — portfolio monitoring, alerts, support, outcomes.
 *
 * Rules under test (plan §8/P8 + §12.2): metrics are dated; deterioration is
 * detected period-over-period against the metric's declared direction; stale and
 * missing data raise alerts against the OPERATOR's `stale_after_days`; severity
 * comes from operator bands and is honestly labelled `severity_unconfigured` when
 * none are set; de-duplication can never hide a worsening severity; suppression
 * caps noise but never severity; AI may propose a support match but can never
 * accept one or contact anyone; acting on a match is the MP-reserved
 * `introduction.relationship_sensitive`; outcomes are append-only and keep the
 * relationship and value notes. Alert VOLUME is reported; alert QUALITY is not
 * claimed from fixtures (§12.4).
 */

let t: TestDb;
let env: Env;

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };
const MEMBER = { "x-wpos-dev-user": "member@westpeek.ventures" };

const MP_ACTOR: Actor = { type: "HUMAN", firmUserId: "fu_scooter_taylor", roles: ["MANAGING_PARTNER"], firmScopes: ["west-peek"] };
const MEMBER_ACTOR: Actor = { type: "HUMAN", firmUserId: "fu_test_member", roles: ["INVESTMENT_TEAM"], firmScopes: ["west-peek"] };
const AI_ACTOR: Actor = { type: "AI", aiEmployeeId: "aie_wyatt", roles: [], firmScopes: ["west-peek"] };

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

let seq = 0;
async function createCompany(): Promise<string> {
  seq += 1;
  const res = await call<{ id: string }>("/api/companies", MP, "POST", { canonical_name: `P8 Co ${seq} ${crypto.randomUUID().slice(0, 8)}` });
  expect(res.status).toBe(201);
  return res.body.id;
}

/** Define a metric once per test file run (metric keys are unique per firm scope). */
async function defineMetric(over: Record<string, unknown> = {}): Promise<string> {
  seq += 1;
  const metricKey = (over.metric_key as string) ?? `arr_${seq}`;
  const res = await call<{ metric_key: string }>("/api/portfolio/metric-definitions", MP, "POST", {
    metric_key: metricKey,
    name: `Metric ${metricKey}`,
    direction: "HIGHER_IS_BETTER",
    ...over,
  });
  expect(res.status).toBe(201);
  return res.body.metric_key;
}

async function snapshot(companyId: string, metricKey: string, asOf: string, value: number): Promise<void> {
  const res = await call("/api/portfolio/snapshots", MP, "POST", {
    company_id: companyId,
    metric_key: metricKey,
    as_of_date: asOf,
    value,
    source: "portfolio update email",
  });
  expect(res.status).toBe(201);
}

interface AlertRow {
  id: string;
  alert_type: string;
  severity: string;
  status: string;
  occurrence_count: number;
  escalated_from: string | null;
  detail_json: string;
  metric_key: string | null;
}

async function evaluate(companyId: string): Promise<AlertRow[]> {
  const res = await call<{ results: Array<{ alert: AlertRow; disposition: string }> }>(`/api/portfolio/companies/${companyId}/evaluate`, MP, "POST", {});
  expect(res.status).toBe(201);
  return res.body.results.map((r) => r.alert);
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db, { WP_OS_DOCUMENTS: t.docs });
  await t.db
    .prepare("INSERT INTO firm_user (id, email, full_name, status) VALUES ('fu_test_member', 'member@westpeek.ventures', 'Test Member', 'ACTIVE')")
    .run();
  await t.db.prepare("INSERT INTO firm_user_role (firm_user_id, role_id) VALUES ('fu_test_member', 'role_investment_team')").run();
});

afterAll(async () => {
  await disposeTestDb(t);
});

// ── 0. Unauthenticated requests are denied ──

describe("0. unauthenticated requests are denied (401) across the P8 surface", () => {
  it("returns 401 on every P8 route", async () => {
    const routes: Array<[string, string, unknown?]> = [
      ["POST", "/api/portfolio/metric-definitions", {}],
      ["GET", "/api/portfolio/metric-definitions"],
      ["POST", "/api/portfolio/updates", {}],
      ["POST", "/api/portfolio/snapshots", {}],
      ["GET", "/api/portfolio/snapshots"],
      ["POST", "/api/portfolio/companies/cc_x/evaluate", {}],
      ["GET", "/api/portfolio/alerts"],
      ["POST", "/api/portfolio/alerts/pal_x/decide", {}],
      ["POST", "/api/portfolio/suppression-rules", {}],
      ["POST", "/api/support/requests", {}],
      ["GET", "/api/support/requests"],
      ["GET", "/api/support/requests/sur_x"],
      ["POST", "/api/support/requests/sur_x/matches", {}],
      ["POST", "/api/support/requests/sur_x/outcomes", {}],
      ["POST", "/api/support/matches/sum_x/decide", {}],
      ["GET", "/api/diagnostics/alert-volume"],
    ];
    for (const [method, path, body] of routes) {
      const res = await handleRequest(req(path, {}, method, body), env);
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });
});

// ── 1. Period-over-period deterioration ──

describe("1. deterioration is detected period-over-period against the metric direction", () => {
  it("assessDeterioration is a pure, direction-aware comparison", () => {
    const bands = { MEDIUM: 5, HIGH: 15, CRITICAL: 30 };
    expect(assessDeterioration(100, 80, "HIGHER_IS_BETTER", bands)).toMatchObject({ deteriorated: true, change_pct: 20, severity: "HIGH" });
    expect(assessDeterioration(100, 120, "HIGHER_IS_BETTER", bands).deteriorated).toBe(false);
    // For a lower-is-better metric (burn), an INCREASE is the deterioration.
    expect(assessDeterioration(100, 140, "LOWER_IS_BETTER", bands)).toMatchObject({ deteriorated: true, severity: "CRITICAL" });
    expect(assessDeterioration(100, 90, "LOWER_IS_BETTER", bands).deteriorated).toBe(false);
    // No operator bands → LOW floor, explicitly flagged as unconfigured.
    expect(assessDeterioration(100, 10, "HIGHER_IS_BETTER", {})).toMatchObject({ deteriorated: true, severity: "LOW", severity_configured: false });
  });

  it("raises a deterioration alert with both dated values and an honest severity source", async () => {
    const company = await createCompany();
    const metric = await defineMetric({ severity_bands: { MEDIUM: 5, HIGH: 15, CRITICAL: 30 } });
    await snapshot(company, metric, "2026-01-31", 1000);
    await snapshot(company, metric, "2026-02-28", 800);
    const alerts = await evaluate(company);
    const deterioration = alerts.find((a) => a.alert_type === "METRIC_DETERIORATION")!;
    expect(deterioration.severity).toBe("HIGH");
    const detail = JSON.parse(deterioration.detail_json);
    expect(detail.previous.value).toBe(1000);
    expect(detail.current.value).toBe(800);
    expect(detail.change_pct).toBeCloseTo(20, 6);
    expect(detail.severity_source).toBe("operator_bands");
  });

  it("with no operator bands the alert still fires but says the severity is unconfigured", async () => {
    const company = await createCompany();
    const metric = await defineMetric();
    await snapshot(company, metric, "2026-01-31", 500);
    await snapshot(company, metric, "2026-02-28", 100);
    const alerts = await evaluate(company);
    const deterioration = alerts.find((a) => a.alert_type === "METRIC_DETERIORATION")!;
    expect(deterioration.severity).toBe("LOW");
    expect(JSON.parse(deterioration.detail_json).severity_source).toBe("severity_unconfigured");
  });

  it("improvement raises nothing", async () => {
    const company = await createCompany();
    const metric = await defineMetric();
    await snapshot(company, metric, "2026-01-31", 100);
    await snapshot(company, metric, "2026-02-28", 150);
    expect(await evaluate(company)).toHaveLength(0);
  });
});

// ── 2. Stale and missing data ──

describe("2. stale and missing data raise their own alerts", () => {
  it("raises STALE_UPDATE once the newest snapshot is older than the operator's window", async () => {
    const company = await createCompany();
    const metric = await defineMetric({ stale_after_days: 45 });
    await snapshot(company, metric, "2020-01-01", 10);
    const alerts = await evaluate(company);
    const stale = alerts.find((a) => a.alert_type === "STALE_UPDATE")!;
    expect(stale).toBeTruthy();
    expect(JSON.parse(stale.detail_json).stale_after_days).toBe(45);
    expect(JSON.parse(stale.detail_json).age_days).toBeGreaterThan(45);
  });

  it("raises MISSING_METRIC when a monitored metric has no snapshot at all", async () => {
    const company = await createCompany();
    const metric = await defineMetric({ stale_after_days: 30 });
    const alerts = await evaluate(company);
    const missing = alerts.find((a) => a.alert_type === "MISSING_METRIC" && a.metric_key === metric);
    expect(missing).toBeTruthy();
  });

  it("a metric with no stale window is never reported as stale or missing", async () => {
    const company = await createCompany();
    const unmonitored = await defineMetric({ metric_key: `unmonitored_${Date.now()}` });
    const alerts = await evaluate(company);
    // Other monitored metrics may legitimately raise MISSING_METRIC for this new
    // company; the metric WITHOUT a stale window must raise nothing at all.
    expect(alerts.filter((a) => a.metric_key === unmonitored)).toHaveLength(0);
  });
});

// ── 3. De-duplication can never hide a worsening severity ──

describe("3. de-duplication is escalation-safe", () => {
  it("folds a repeat at the same severity but opens a NEW alert when severity worsens", async () => {
    const company = await createCompany();
    const metric = await defineMetric({ severity_bands: { MEDIUM: 5, HIGH: 15, CRITICAL: 30 } });
    await snapshot(company, metric, "2026-01-31", 1000);
    await snapshot(company, metric, "2026-02-28", 900); // −10% → MEDIUM
    const first = (await evaluate(company)).find((a) => a.alert_type === "METRIC_DETERIORATION")!;
    expect(first.severity).toBe("MEDIUM");
    expect(first.occurrence_count).toBe(1);

    // Re-evaluating the same state folds into the same alert.
    const repeat = (await evaluate(company)).find((a) => a.alert_type === "METRIC_DETERIORATION")!;
    expect(repeat.id).toBe(first.id);
    expect(repeat.occurrence_count).toBe(2);

    // A worse period opens a NEW alert linked to the old one — never a silent bump.
    await snapshot(company, metric, "2026-03-31", 500); // −44% vs 900 → CRITICAL
    const escalated = (await evaluate(company)).find((a) => a.alert_type === "METRIC_DETERIORATION")!;
    expect(escalated.id).not.toBe(first.id);
    expect(escalated.severity).toBe("CRITICAL");
    expect(escalated.escalated_from).toBe(first.id);

    const prior = await t.db.prepare("SELECT status, severity, decision_note FROM portfolio_alert WHERE id = ?1").bind(first.id).first<{ status: string; severity: string; decision_note: string }>();
    expect(prior!.severity).toBe("MEDIUM"); // the old row's severity is never rewritten
    expect(prior!.status).toBe("RESOLVED");
    expect(prior!.decision_note).toContain("superseded by higher-severity alert");
  });

  it("a suppression rule silences noise at or below its cap and NEVER anything worse", async () => {
    const company = await createCompany();
    const quiet = await defineMetric({ metric_key: `quiet_${Date.now()}`, severity_bands: { MEDIUM: 5, HIGH: 15, CRITICAL: 30 } });
    const rule = await call("/api/portfolio/suppression-rules", MP, "POST", {
      company_id: company,
      alert_type: "METRIC_DETERIORATION",
      metric_key: quiet,
      max_severity: "MEDIUM",
      reason: "known seasonal dip; reviewed with the founder",
    });
    expect(rule.status).toBe(201);

    await snapshot(company, quiet, "2026-01-31", 100);
    await snapshot(company, quiet, "2026-02-28", 94); // −6% → MEDIUM, suppressed
    const suppressed = (await evaluate(company)).find((a) => a.metric_key === quiet)!;
    expect(suppressed.severity).toBe("MEDIUM");
    expect(suppressed.status).toBe("SUPPRESSED");

    await snapshot(company, quiet, "2026-03-31", 50); // −47% → CRITICAL, must surface
    const surfaced = (await evaluate(company)).find((a) => a.metric_key === quiet)!;
    expect(surfaced.severity).toBe("CRITICAL");
    expect(surfaced.status).toBe("OPEN");
  });
});

// ── 4. Human disposition ──

describe("4. alert disposition is human-only", () => {
  it("an MP can acknowledge and resolve; an AI actor never can", async () => {
    const company = await createCompany();
    const metric = await defineMetric();
    await snapshot(company, metric, "2026-01-31", 100);
    await snapshot(company, metric, "2026-02-28", 80);
    const alert = (await evaluate(company))[0]!;

    const acknowledged = await call<{ status: string; decided_by: string }>(`/api/portfolio/alerts/${alert.id}/decide`, MP, "POST", { to: "ACKNOWLEDGED", note: "spoke with founder" });
    expect(acknowledged.status).toBe(200);
    expect(acknowledged.body.status).toBe("ACKNOWLEDGED");
    expect(acknowledged.body.decided_by).toBe("fu_scooter_taylor");

    const { decideAlert } = await import("../src/worker/services/portfolio");
    await expect(decideAlert(env, AI_ACTOR, alert.id, "RESOLVED")).rejects.toMatchObject({ status: 403 });

    const resolved = await call<{ status: string }>(`/api/portfolio/alerts/${alert.id}/decide`, MP, "POST", { to: "RESOLVED" });
    expect(resolved.body.status).toBe("RESOLVED");
    const again = await call(`/api/portfolio/alerts/${alert.id}/decide`, MP, "POST", { to: "RESOLVED" });
    expect(again.status).toBe(409);
  });
});

// ── 5. Support: AI proposes, humans decide, introductions stay reserved ──

describe("5. support matching never becomes contact", () => {
  it("an AI-proposed match needs its run trace, cannot be accepted by the AI, and sends nothing", async () => {
    const company = await createCompany();
    const request = await call<{ id: string }>("/api/support/requests", MP, "POST", {
      company_id: company,
      request_type: "HIRING",
      description: "Needs a VP Eng candidate pipeline",
      urgency: "HIGH",
    });
    expect(request.status).toBe(201);

    await expect(
      proposeSupportMatch(env, AI_ACTOR, request.body.id, { match_type: "PERSON", target_label: "Jane Doe", rationale: "ran eng at a similar stage" }),
    ).rejects.toMatchObject({ status: 400 });

    const run = await runAi(env, { purpose: "support_match_suggestion", actor: AI_ACTOR, inputs: ["VP Eng pipeline"], sensitivity: "INTERNAL" });
    const match = await proposeSupportMatch(env, AI_ACTOR, request.body.id, {
      match_type: "PERSON",
      target_label: "Jane Doe",
      rationale: "ran eng at a similar stage",
      ai_run_id: run.run.id,
    });
    expect(match.proposed_by_type).toBe("AI");
    expect(match.status).toBe("PROPOSED");

    // The AI can never accept its own suggestion.
    await expect(decideSupportMatch(env, AI_ACTOR, match.id, "ACCEPTED")).rejects.toMatchObject({ status: 403 });

    // A human accepting only opens the MP-reserved introduction approval card.
    const accepted = await decideSupportMatch(env, MEMBER_ACTOR, match.id, "ACCEPTED");
    expect(accepted.status).toBe("ACCEPTED");
    expect(accepted.approval_card_id).toMatch(/^apc_/);
    const card = await call<{ action_key: string; state: string; required_approver_roles_json: string }>(`/api/approvals/${accepted.approval_card_id}`, MP);
    expect(card.body.action_key).toBe("introduction.relationship_sensitive");
    expect(card.body.state).toBe("pending_review");
    expect(JSON.parse(card.body.required_approver_roles_json)).toContain("MANAGING_PARTNER");

    // The accepting non-MP cannot approve that card…
    const selfApprove = await call(`/api/approvals/${accepted.approval_card_id}/decide`, MEMBER, "POST", { decision: "approved" });
    expect(selfApprove.status).toBe(403);
    // …and no external effect has been executed by any of this.
    const effects = await t.db.prepare("SELECT COUNT(*) AS n FROM external_effect_request").first<{ n: number }>();
    expect(effects!.n).toBe(0);
  });

  it("outcomes are append-only and keep the relationship and value notes", async () => {
    const company = await createCompany();
    const request = await call<{ id: string }>("/api/support/requests", MP, "POST", {
      company_id: company,
      request_type: "CUSTOMER_INTRO",
      description: "Warm intro to two logos",
    });
    const outcome = await call<{ id: string; outcome_type: string; value_note: string; relationship_note: string }>(
      `/api/support/requests/${request.body.id}/outcomes`,
      MP,
      "POST",
      {
        outcome_type: "PARTIALLY_HELPED",
        value_note: "One intro converted to a pilot; the other went nowhere.",
        relationship_note: "Founder felt supported; the intro contact wants less volume.",
      },
    );
    expect(outcome.status).toBe(201);
    expect(outcome.body.value_note).toContain("pilot");
    expect(outcome.body.relationship_note).toContain("less volume");

    await expect(t.db.prepare("UPDATE support_outcome SET outcome_type = 'HELPED' WHERE id = ?1").bind(outcome.body.id).run()).rejects.toThrow(/append-only/);
    await expect(t.db.prepare("DELETE FROM support_outcome WHERE id = ?1").bind(outcome.body.id).run()).rejects.toThrow(/append-only/);

    const view = await call<{ outcomes: unknown[] }>(`/api/support/requests/${request.body.id}`, MP);
    expect(view.body.outcomes).toHaveLength(1);
  });

  it("an AI actor cannot record an outcome", async () => {
    const company = await createCompany();
    const request = await call<{ id: string }>("/api/support/requests", MP, "POST", { company_id: company, request_type: "OTHER", description: "x" });
    await expect(recordSupportOutcome(env, AI_ACTOR, request.body.id, { outcome_type: "HELPED" })).rejects.toMatchObject({ status: 403 });
  });
});

// ── 6. Volume reporting, dated data, and scope ──

describe("6. volume is reported without any alert-quality claim", () => {
  it("reports counts by day and severity with an explicit UNPROVEN quality note", async () => {
    const volume = await call<{ note: string; by_day: Array<{ day: string; count: number }>; by_severity_status: unknown[] }>("/api/diagnostics/alert-volume", MP);
    expect(volume.status).toBe(200);
    expect(volume.body.note).toContain("UNPROVEN");
    expect(volume.body.by_day.length).toBeGreaterThan(0);
    expect(volume.body.by_severity_status.length).toBeGreaterThan(0);
  });

  it("a snapshot for an undefined metric is refused (metrics are defined, not invented)", async () => {
    const company = await createCompany();
    const res = await call<{ error: string }>("/api/portfolio/snapshots", MP, "POST", {
      company_id: company,
      metric_key: "never_defined_metric",
      as_of_date: "2026-01-01",
      value: 1,
      source: "x",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("unknown_metric");
  });

  it("an MNPI_SENSITIVE snapshot is invisible to a non-MP user", async () => {
    const company = await createCompany();
    const metric = await defineMetric();
    const res = await call("/api/portfolio/snapshots", MP, "POST", {
      company_id: company,
      metric_key: metric,
      as_of_date: "2026-02-01",
      value: 42,
      source: "restricted",
      privacy_label: "MNPI_SENSITIVE",
    });
    expect(res.status).toBe(201);
    const asMember = await call<{ metric_snapshots: unknown[] }>(`/api/portfolio/snapshots?company_id=${company}`, MEMBER);
    expect(asMember.body.metric_snapshots).toHaveLength(0);
    const asMp = await call<{ metric_snapshots: unknown[] }>(`/api/portfolio/snapshots?company_id=${company}`, MP);
    expect(asMp.body.metric_snapshots).toHaveLength(1);
  });

  it("the journey leaves typed events on the ONE spine (D15)", async () => {
    const company = await createCompany();
    const metric = await defineMetric();
    await call("/api/portfolio/updates", MP, "POST", { company_id: company, received_at: "2026-03-01", source: "founder email", period_label: "Feb 2026" });
    await snapshot(company, metric, "2026-01-31", 10);
    await snapshot(company, metric, "2026-02-28", 5);
    await evaluateCompanyAlerts(env, MP_ACTOR, company);
    const events = await t.db
      .prepare("SELECT event_type FROM event_record WHERE json_extract(payload_json, '$.company_id') = ?1 ORDER BY created_at, id")
      .bind(company)
      .all<{ event_type: string }>();
    const types = new Set((events.results ?? []).map((e) => e.event_type));
    for (const expected of ["portfolio.update_recorded", "portfolio.metric_snapshot_recorded", "portfolio.alert_raised"]) {
      expect(types, expected).toContain(expected);
    }
  });
});
