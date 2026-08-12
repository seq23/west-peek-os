import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { handleRequest } from "../src/worker/index";
import type { Env } from "../src/worker/env";
import {
  createClaim,
  createContradiction,
  createSourceConflict,
  parseClaimCandidates,
  proposeContradictionCandidates,
  resolveContradiction,
  resolveSourceConflict,
  type DiligenceClaimRow,
} from "../src/worker/services/evidence";
import type { Actor } from "../src/worker/services/authorize";

/**
 * P5 — evidence/provenance substrate suite (D16). Every test targets a specific
 * rule: mandatory source provenance, the structural self-promotion ban (AI or
 * model/transcript/web/vendor-sourced claims can NEVER become VERIFIED),
 * supersession chains, contradiction lifecycle + downstream visibility,
 * knowledge promotion through the approval path, document round-trip integrity
 * (R2 + SHA-256), and append-only source resolution. Extraction runs through the
 * mock-local adapter only — real provider extraction is UNPROVEN (CREDENTIAL GATE).
 */

let t: TestDb;
let env: Env; // with R2 binding
let envNoR2: Env; // degraded mode: no WP_OS_DOCUMENTS

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };

const MP_ACTOR: Actor = { type: "HUMAN", firmUserId: "fu_scooter_taylor", roles: ["MANAGING_PARTNER"], firmScopes: ["west-peek"] };
const AI_ACTOR: Actor = { type: "AI", aiEmployeeId: "aie_paige", roles: [], firmScopes: ["west-peek"] };

function req(path: string, headers: Record<string, string> = {}, method = "GET", body?: unknown): Request {
  return new Request(`https://test.local${path}`, {
    method,
    headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const HUMAN_SOURCE = {
  source_type: "HUMAN_STATEMENT",
  location: "founder call 2026-01-15, 14:00",
  source_date: "2026-01-15",
  method: "interview notes",
} as const;

let companySeq = 0;
async function createCompany(name?: string): Promise<string> {
  companySeq += 1;
  const res = await handleRequest(
    req("/api/companies", MP, "POST", { canonical_name: name ?? `P5 Company ${companySeq} ${crypto.randomUUID().slice(0, 8)}` }),
    env,
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function uploadFixture(text: string, title = "fixture doc"): Promise<{ documentId: string; versionId: string }> {
  const res = await handleRequest(
    req("/api/documents", MP, "POST", { title, doc_type: "diligence_note", content_base64: b64(text), content_type: "text/plain" }),
    env,
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as { id: string; version: { id: string } };
  return { documentId: body.id, versionId: body.version.id };
}

interface ClaimInputOverrides {
  claim_text?: string;
  metric_key?: string;
  metric_value?: string;
  period_start?: string;
  period_end?: string;
  claim_status?: string;
  sources?: unknown[];
}

async function createClaimApi(companyId: string, overrides: ClaimInputOverrides = {}): Promise<{ status: number; body: DiligenceClaimRow & { error?: string } }> {
  const res = await handleRequest(
    req("/api/claims", MP, "POST", {
      company_id: companyId,
      subject_type: "company",
      subject_id: companyId,
      claim_text: overrides.claim_text ?? "ARR is $4M",
      metric_key: overrides.metric_key,
      metric_value: overrides.metric_value,
      period_start: overrides.period_start,
      period_end: overrides.period_end,
      claim_status: overrides.claim_status,
      confidence: 0.8,
      sources: overrides.sources ?? [{ ...HUMAN_SOURCE }],
    }),
    env,
  );
  return { status: res.status, body: (await res.json()) as DiligenceClaimRow & { error?: string } };
}

/** Create + submit + approve an approval card as MP; returns the card id. */
async function approvedCard(actionKey: string, objectType: string, objectId: string): Promise<string> {
  const created = await handleRequest(
    req("/api/approvals", MP, "POST", { action_key: actionKey, object_type: objectType, object_id: objectId, title: `p5: ${actionKey} ${objectId}`, submit: true }),
    env,
  );
  expect(created.status).toBe(201);
  const card = (await created.json()) as { id: string };
  const decided = await handleRequest(req(`/api/approvals/${card.id}/decide`, MP, "POST", { decision: "approved" }), env);
  expect(decided.status).toBe(200);
  return card.id;
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db, { WP_OS_DOCUMENTS: t.docs });
  envNoR2 = makeTestEnv(t.db);
});

afterAll(async () => {
  await disposeTestDb(t);
});

// ── 0. Unauthenticated requests are denied on every P5 route ──

describe("0. unauthenticated requests are denied (401) across the P5 surface", () => {
  it("returns 401 on all P5 routes", async () => {
    const routes: Array<[string, string, unknown?]> = [
      ["POST", "/api/documents", { title: "x", doc_type: "y", content_base64: "eA==", content_type: "text/plain" }],
      ["GET", "/api/documents"],
      ["GET", "/api/documents/doc_x"],
      ["POST", "/api/documents/doc_x/versions", { content_base64: "eA==", content_type: "text/plain" }],
      ["GET", "/api/documents/doc_x/download"],
      ["POST", "/api/claims", {}],
      ["GET", "/api/claims"],
      ["POST", "/api/claims/extract", { document_version_id: "dver_x" }],
      ["GET", "/api/claims/clm_x"],
      ["POST", "/api/claims/clm_x/verify", {}],
      ["POST", "/api/claims/clm_x/accept", {}],
      ["POST", "/api/claims/clm_x/supersede", {}],
      ["POST", "/api/contradictions", {}],
      ["GET", "/api/contradictions"],
      ["GET", "/api/contradictions/ctr_x"],
      ["POST", "/api/contradictions/ctr_x/investigate", {}],
      ["POST", "/api/contradictions/ctr_x/resolve", {}],
      ["GET", "/api/companies/cc_x/evidence-summary"],
      ["GET", "/api/companies/cc_x/contradiction-candidates"],
      ["POST", "/api/knowledge/promotion-candidates", {}],
      ["GET", "/api/knowledge/promotion-candidates"],
      ["POST", "/api/knowledge/promotion-candidates/kpc_x/apply", {}],
      ["POST", "/api/knowledge/promotion-candidates/kpc_x/reject", {}],
      ["GET", "/api/knowledge/records"],
      ["GET", "/api/knowledge/records/knw_x"],
      ["POST", "/api/source-conflicts", {}],
      ["GET", "/api/source-conflicts"],
      ["GET", "/api/source-conflicts/scf_x"],
      ["POST", "/api/source-conflicts/scf_x/resolve", {}],
    ];
    for (const [method, path, body] of routes) {
      const res = await handleRequest(req(path, {}, method, body), env);
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });
});

// ── 1. Contradiction creation across value / period / definition ──

describe("1. contradiction creation across conflicting value, period, and definition", () => {
  it("VALUE: same metric, differing values → candidate + OPEN contradiction with linked claims", async () => {
    const company = await createCompany("Value Conflict Co");
    const a = await createClaimApi(company, { metric_key: "arr", metric_value: "$4M", claim_text: "ARR is $4M", period_start: "2025-01-01", period_end: "2025-12-31" });
    const b = await createClaimApi(company, { metric_key: "arr", metric_value: "$6M", claim_text: "ARR is $6M", period_start: "2025-01-01", period_end: "2025-12-31" });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);

    const candidates = await proposeContradictionCandidates(env, company);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.contradiction_type).toBe("VALUE");
    expect(candidates[0]!.claim_ids.sort()).toEqual([a.body.id, b.body.id].sort());

    const created = await handleRequest(
      req("/api/contradictions", MP, "POST", {
        contradiction_type: "VALUE",
        topic: candidates[0]!.topic,
        company_id: company,
        materiality: "HIGH",
        required_question: "Which ARR figure is current?",
        claim_links: [
          { claim_id: a.body.id, side_label: "pitch_deck" },
          { claim_id: b.body.id, side_label: "data_room" },
        ],
      }),
      env,
    );
    expect(created.status).toBe(201);
    const contradiction = (await created.json()) as { id: string; status: string; proposed_by_type: string };
    expect(contradiction.status).toBe("OPEN");
    expect(contradiction.proposed_by_type).toBe("HUMAN");

    const detail = await handleRequest(req(`/api/contradictions/${contradiction.id}`, MP), env);
    const detailBody = (await detail.json()) as { claim_links: Array<{ claim_id: string; side_label: string }> };
    expect(detailBody.claim_links).toHaveLength(2);
    expect(detailBody.claim_links.map((l) => l.side_label).sort()).toEqual(["data_room", "pitch_deck"]);
  });

  it("PERIOD: same value, differing periods → PERIOD candidate", async () => {
    const company = await createCompany("Period Conflict Co");
    const a = await createClaimApi(company, { metric_key: "burn", metric_value: "$200k/mo", claim_text: "Burn is $200k/mo", period_start: "2024-01-01", period_end: "2024-12-31" });
    const b = await createClaimApi(company, { metric_key: "burn", metric_value: "$200k/mo", claim_text: "Burn is $200k/mo", period_start: "2025-01-01", period_end: "2025-12-31" });
    const candidates = await proposeContradictionCandidates(env, company);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.contradiction_type).toBe("PERIOD");
    expect(candidates[0]!.claim_ids.sort()).toEqual([a.body.id, b.body.id].sort());
  });

  it("DEFINITION: same value and period, differing wording → DEFINITION candidate", async () => {
    const company = await createCompany("Definition Conflict Co");
    await createClaimApi(company, { metric_key: "mrr", metric_value: "$100k", claim_text: "MRR is $100k including usage revenue", period_start: "2025-01-01", period_end: "2025-12-31" });
    await createClaimApi(company, { metric_key: "mrr", metric_value: "$100k", claim_text: "MRR is $100k excluding usage revenue", period_start: "2025-01-01", period_end: "2025-12-31" });
    const candidates = await proposeContradictionCandidates(env, company);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.contradiction_type).toBe("DEFINITION");
  });

  it("AI may PROPOSE a contradiction (enters OPEN with proposed-by recorded) but may never RESOLVE one", async () => {
    const company = await createCompany("AI Proposal Co");
    const a = await createClaimApi(company, { metric_key: "arr", metric_value: "$4M" });
    const b = await createClaimApi(company, { metric_key: "arr", metric_value: "$9M" });

    const proposed = await createContradiction(env, AI_ACTOR, {
      contradiction_type: "VALUE",
      topic: "arr mismatch",
      company_id: company,
      materiality: "MEDIUM",
      claim_links: [
        { claim_id: a.body.id, side_label: "a" },
        { claim_id: b.body.id, side_label: "b" },
      ],
    });
    expect(proposed.status).toBe("OPEN");
    expect(proposed.proposed_by_type).toBe("AI");
    expect(proposed.proposed_by_id).toBe("aie_paige");

    await expect(
      resolveContradiction(env, AI_ACTOR, proposed.id, "RESOLVED", { note: "ai tried" }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

// ── 2. Supersession chain ──

describe("2. supersession chain: A → B → C, all readable, current pointer correct", () => {
  it("chains replacements and keeps every link readable", async () => {
    const company = await createCompany("Supersede Co");
    const a = await createClaimApi(company, { claim_text: "Headcount is 12", metric_key: "headcount", metric_value: "12" });
    expect(a.status).toBe(201);

    const bRes = await handleRequest(
      req(`/api/claims/${a.body.id}/supersede`, MP, "POST", {
        company_id: company,
        subject_type: "company",
        subject_id: company,
        claim_text: "Headcount is 14",
        metric_key: "headcount",
        metric_value: "14",
        confidence: 0.85,
        sources: [{ ...HUMAN_SOURCE }],
      }),
      env,
    );
    expect(bRes.status).toBe(201);
    const b = (await bRes.json()) as DiligenceClaimRow;

    const cRes = await handleRequest(
      req(`/api/claims/${b.id}/supersede`, MP, "POST", {
        company_id: company,
        subject_type: "company",
        subject_id: company,
        claim_text: "Headcount is 17",
        metric_key: "headcount",
        metric_value: "17",
        confidence: 0.9,
        sources: [{ ...HUMAN_SOURCE }],
      }),
      env,
    );
    expect(cRes.status).toBe(201);
    const c = (await cRes.json()) as DiligenceClaimRow;

    // All three remain readable; superseded_by links form the chain; C is current.
    const readA = (await (await handleRequest(req(`/api/claims/${a.body.id}`, MP), env)).json()) as DiligenceClaimRow;
    const readB = (await (await handleRequest(req(`/api/claims/${b.id}`, MP), env)).json()) as DiligenceClaimRow;
    const readC = (await (await handleRequest(req(`/api/claims/${c.id}`, MP), env)).json()) as DiligenceClaimRow;
    expect(readA.superseded_by).toBe(b.id);
    expect(readB.superseded_by).toBe(c.id);
    expect(readC.superseded_by).toBeNull();

    // The chain's current claim is the only one with no successor.
    const list = (await (await handleRequest(req(`/api/claims?company_id=${company}`, MP), env)).json()) as { claims: DiligenceClaimRow[] };
    const current = list.claims.filter((cl) => cl.superseded_by === null);
    expect(current.map((cl) => cl.id)).toEqual([c.id]);

    // Double supersession is refused.
    const again = await handleRequest(
      req(`/api/claims/${a.body.id}/supersede`, MP, "POST", {
        company_id: company,
        subject_type: "company",
        subject_id: company,
        claim_text: "Headcount is 99",
        confidence: 0.5,
        sources: [{ ...HUMAN_SOURCE }],
      }),
      env,
    );
    expect(again.status).toBe(409);
  });
});

// ── 3. Source preservation ──

describe("3. source preservation: every claim carries source/date/location/method/confidence/status", () => {
  it("create without sources → 400; source missing mandatory fields → 400", async () => {
    const company = await createCompany("Source Gate Co");
    const base = { company_id: company, subject_type: "company", subject_id: company, claim_text: "x", confidence: 0.5 };

    const noSources = await handleRequest(req("/api/claims", MP, "POST", { ...base, sources: [] }), env);
    expect(noSources.status).toBe(400);

    const missingSources = await handleRequest(req("/api/claims", MP, "POST", { ...base }), env);
    expect(missingSources.status).toBe(400);

    for (const field of ["location", "source_date", "method"] as const) {
      const source: Record<string, string> = { ...HUMAN_SOURCE };
      delete source[field];
      const res = await handleRequest(req("/api/claims", MP, "POST", { ...base, sources: [source] }), env);
      expect(res.status, `missing ${field}`).toBe(400);
    }

    const noConfidence = await handleRequest(req("/api/claims", MP, "POST", { company_id: company, subject_type: "company", subject_id: company, claim_text: "x", sources: [{ ...HUMAN_SOURCE }] }), env);
    expect(noConfidence.status).toBe(400);

    // A well-formed claim round-trips every provenance field.
    const ok = await createClaimApi(company, { claim_text: "NRR is 118%" });
    expect(ok.status).toBe(201);
    const detail = (await (await handleRequest(req(`/api/claims/${ok.body.id}`, MP), env)).json()) as DiligenceClaimRow & { sources: Array<Record<string, unknown>> };
    expect(detail.claim_status).toBe("UNVERIFIED");
    expect(detail.confidence).toBe(0.8);
    expect(detail.sources).toHaveLength(1);
    expect(detail.sources[0]).toMatchObject({
      source_type: "HUMAN_STATEMENT",
      location: HUMAN_SOURCE.location,
      source_date: HUMAN_SOURCE.source_date,
      method: HUMAN_SOURCE.method,
    });
  });
});

// ── 4. Unresolved material contradictions are visible in the evidence summary ──

describe("4. evidence-summary surfaces unresolved material contradictions (structurally un-hidable)", () => {
  it("OPEN/INVESTIGATING HIGH/CRITICAL contradictions always appear; no query param removes them", async () => {
    const company = await createCompany("Summary Co");
    const a = await createClaimApi(company, { metric_key: "arr", metric_value: "$4M", claim_status: "FOUNDER_STATED" });
    const b = await createClaimApi(company, { metric_key: "arr", metric_value: "$6M", claim_status: "THIRD_PARTY_SOURCED" });

    const mk = async (materiality: string, status: "open" | "resolved") => {
      const created = await handleRequest(
        req("/api/contradictions", MP, "POST", {
          contradiction_type: "VALUE",
          topic: `arr ${materiality} ${status}`,
          company_id: company,
          materiality,
          claim_links: [
            { claim_id: a.body.id, side_label: "a" },
            { claim_id: b.body.id, side_label: "b" },
          ],
        }),
        env,
      );
      const row = (await created.json()) as { id: string };
      if (status === "resolved") {
        await handleRequest(req(`/api/contradictions/${row.id}/resolve`, MP, "POST", { disposition: "RESOLVED", resolution_evidence: { note: "confirmed $4M" } }), env);
      }
      return row.id;
    };
    const highOpen = await mk("HIGH", "open");
    const criticalOpen = await mk("CRITICAL", "open");
    const lowOpen = await mk("LOW", "open");
    const highResolved = await mk("HIGH", "resolved");

    const summary = (await (await handleRequest(req(`/api/companies/${company}/evidence-summary`, MP), env)).json()) as {
      claims_by_status: Record<string, number>;
      unresolved_material_contradictions: Array<{ id: string; status: string; materiality: string }>;
    };
    const ids = summary.unresolved_material_contradictions.map((c) => c.id);
    expect(ids).toContain(highOpen);
    expect(ids).toContain(criticalOpen);
    expect(ids).not.toContain(lowOpen); // not material
    expect(ids).not.toContain(highResolved); // resolved
    expect(summary.claims_by_status.FOUNDER_STATED).toBe(1);
    expect(summary.claims_by_status.THIRD_PARTY_SOURCED).toBe(1);

    // Investigating stays visible.
    await handleRequest(req(`/api/contradictions/${highOpen}/investigate`, MP, "POST", {}), env);
    const after = (await (await handleRequest(req(`/api/companies/${company}/evidence-summary?materiality=LOW&status=RESOLVED`, MP), env)).json()) as {
      unresolved_material_contradictions: Array<{ id: string; status: string }>;
    };
    const afterIds = after.unresolved_material_contradictions.map((c) => c.id);
    expect(afterIds).toContain(highOpen); // INVESTIGATING still surfaces
    expect(afterIds).toContain(criticalOpen); // query params cannot filter the section out
  });
});

// ── 5. Self-promotion ban: no route can make model/transcript/web/vendor-only claims VERIFIED ──

describe("5. self-promotion ban (structural): AI / model / transcript / web / vendor-only claims can NEVER be VERIFIED", () => {
  it("direct create with VERIFIED + non-qualifying sources is refused (409)", async () => {
    const company = await createCompany("Ban Co");
    for (const sourceType of ["MODEL_OUTPUT", "TRANSCRIPT", "WEB", "VENDOR"] as const) {
      const res = await createClaimApi(company, {
        claim_status: "VERIFIED",
        sources: [{ source_type: sourceType, location: "somewhere", source_date: "2026-01-01", method: "ingest" }],
      });
      expect(res.status, sourceType).toBe(409);
      expect(res.body.error, sourceType).toBe("self_promotion_ban");
    }
  });

  it("service-level create by an AI actor can never land VERIFIED; defaults to AI_INFERRED", async () => {
    const company = await createCompany("Ban Service Co");
    await expect(
      createClaim(
        env,
        AI_ACTOR,
        {
          company_id: company,
          subject_type: "company",
          subject_id: company,
          claim_text: "AI says ARR is $10M",
          claim_status: "VERIFIED",
          confidence: 0.9,
          sources: [{ source_type: "MODEL_OUTPUT", location: "run", source_date: "2026-01-01", method: "run_ai" }],
        },
        { extractor: { type: "AI", id: "mock-local" } },
      ),
    ).rejects.toMatchObject({ status: 409, code: "self_promotion_ban" });

    const ok = await createClaim(
      env,
      AI_ACTOR,
      {
        company_id: company,
        subject_type: "company",
        subject_id: company,
        claim_text: "AI draft claim",
        confidence: 0.4,
        sources: [{ source_type: "MODEL_OUTPUT", location: "run", source_date: "2026-01-01", method: "run_ai" }],
      },
      { extractor: { type: "AI", id: "mock-local" } },
    );
    expect(ok.claim_status).toBe("AI_INFERRED");
    expect(ok.extracted_by_type).toBe("AI");

    // The database CHECK makes the ban structural even below the service layer.
    await expect(
      t.db.prepare("UPDATE diligence_claim SET claim_status = 'VERIFIED' WHERE id = ?1").bind(ok.id).run(),
    ).rejects.toThrow();
  });

  it("verify refuses AI-extracted claims and claims without a DOCUMENT/HUMAN_STATEMENT source; no generic status route exists", async () => {
    const company = await createCompany("Ban Verify Co");

    // Human-created, but only WEB/TRANSCRIPT sources → verify refuses.
    const webOnly = await createClaimApi(company, {
      sources: [{ source_type: "WEB", location: "https://public.example/page", source_date: "2026-01-01", method: "scrape" }],
    });
    const verifyWeb = await handleRequest(req(`/api/claims/${webOnly.body.id}/verify`, MP, "POST", {}), env);
    expect(verifyWeb.status).toBe(409);
    expect(((await verifyWeb.json()) as { error: string }).error).toBe("self_promotion_ban");

    // AI-extracted claim → verify refuses outright (accept flow is the only path).
    const aiClaim = await createClaim(
      env,
      AI_ACTOR,
      {
        company_id: company,
        subject_type: "company",
        subject_id: company,
        claim_text: "AI extracted something",
        confidence: 0.4,
        sources: [{ source_type: "MODEL_OUTPUT", location: "run", source_date: "2026-01-01", method: "run_ai" }],
      },
      { extractor: { type: "AI", id: "mock-local" } },
    );
    const verifyAi = await handleRequest(req(`/api/claims/${aiClaim.id}/verify`, MP, "POST", {}), env);
    expect(verifyAi.status).toBe(409);
    expect(((await verifyAi.json()) as { error: string }).error).toBe("self_promotion_ban");

    // Attaching a qualifying source at verify time still cannot rescue an AI-extracted claim.
    const verifyAiWithDoc = await handleRequest(
      req(`/api/claims/${aiClaim.id}/verify`, MP, "POST", {
        source: { source_type: "HUMAN_STATEMENT", location: "call", source_date: "2026-02-01", method: "interview" },
      }),
      env,
    );
    expect(verifyAiWithDoc.status).toBe(409);

    // There is no generic status-update route — direct flips 404.
    const patch = await handleRequest(req(`/api/claims/${webOnly.body.id}`, MP, "PATCH", { claim_status: "VERIFIED" }), env);
    expect(patch.status).toBe(404);
    const post = await handleRequest(req(`/api/claims/${webOnly.body.id}`, MP, "POST", { claim_status: "VERIFIED" }), env);
    expect(post.status).toBe(404);

    // The claims are untouched.
    const reread = (await (await handleRequest(req(`/api/claims/${webOnly.body.id}`, MP), env)).json()) as DiligenceClaimRow;
    expect(reread.claim_status).toBe("UNVERIFIED");
  });
});

// ── 6. Human VERIFIED promotion paths ──

describe("6. human VERIFIED promotion works with DOCUMENT sources, incl. the accept-extraction flow", () => {
  it("create VERIFIED with a DOCUMENT source works; verify upgrades FOUNDER_STATED; accept promotes an AI extraction", async () => {
    const company = await createCompany("Verify Co");
    const fixture = await uploadFixture("ARR: $4.2M (2025)\nBurn: $180k/mo (2025)", "financials.txt");
    const docSource = {
      source_type: "DOCUMENT",
      document_version_id: fixture.versionId,
      location: "page 1",
      source_date: "2026-01-20",
      method: "document review",
    };

    // Direct create as VERIFIED with a DOCUMENT source.
    const direct = await createClaimApi(company, { claim_text: "ARR is $4.2M", metric_key: "arr", metric_value: "$4.2M", claim_status: "VERIFIED", sources: [docSource] });
    expect(direct.status).toBe(201);
    expect(direct.body.claim_status).toBe("VERIFIED");
    expect(direct.body.extracted_by_type).toBe("HUMAN");

    // FOUNDER_STATED → verify → VERIFIED (qualifying source attached at verify time).
    const founderStated = await createClaimApi(company, { claim_text: "Burn is $180k/mo", metric_key: "burn", metric_value: "$180k/mo", claim_status: "FOUNDER_STATED" });
    const verified = await handleRequest(
      req(`/api/claims/${founderStated.body.id}/verify`, MP, "POST", {
        source: { ...docSource, location: "page 1, burn line" },
      }),
      env,
    );
    expect(verified.status).toBe(200);
    expect(((await verified.json()) as DiligenceClaimRow).claim_status).toBe("VERIFIED");

    // AI extraction → quarantined AI_INFERRED → human accept with DOCUMENT source → VERIFIED.
    const extracted = await handleRequest(
      req("/api/claims/extract", MP, "POST", { document_version_id: fixture.versionId, company_id: company }),
      env,
    );
    expect(extracted.status).toBe(201);
    const extractBody = (await extracted.json()) as { run: { id: string; status: string }; candidates: DiligenceClaimRow[] };
    expect(extractBody.run.status).toBe("COMPLETED");
    expect(extractBody.candidates.length).toBeGreaterThanOrEqual(2);
    const candidate = extractBody.candidates[0]!;
    expect(candidate.claim_status).toBe("AI_INFERRED");
    expect(candidate.extracted_by_type).toBe("AI");
    expect(candidate.ai_run_id).toBe(extractBody.run.id);

    // Accept without a qualifying source → refused; with a DOCUMENT source → VERIFIED,
    // re-attributed to the accepting human, AI origin preserved in ai_run_id.
    const badAccept = await handleRequest(
      req(`/api/claims/${candidate.id}/accept`, MP, "POST", {
        source: { source_type: "WEB", location: "page", source_date: "2026-01-21", method: "scrape" },
      }),
      env,
    );
    expect(badAccept.status).toBe(409);

    const accepted = await handleRequest(
      req(`/api/claims/${candidate.id}/accept`, MP, "POST", { source: { ...docSource, location: "page 1, ARR line" } }),
      env,
    );
    expect(accepted.status).toBe(200);
    const acceptedClaim = (await accepted.json()) as DiligenceClaimRow;
    expect(acceptedClaim.claim_status).toBe("VERIFIED");
    expect(acceptedClaim.extracted_by_type).toBe("HUMAN");
    expect(acceptedClaim.extracted_by_id).toBe("fu_scooter_taylor");
    expect(acceptedClaim.ai_run_id).toBe(extractBody.run.id);

    // Double-accept is refused.
    const twice = await handleRequest(
      req(`/api/claims/${candidate.id}/accept`, MP, "POST", { source: docSource }),
      env,
    );
    expect(twice.status).toBe(409);

    const event = await t.db
      .prepare("SELECT * FROM event_record WHERE event_type = 'claim.accepted' AND object_id = ?1")
      .bind(candidate.id)
      .first<{ payload_json: string }>();
    expect(event).not.toBeNull();
    expect(JSON.parse(event!.payload_json).original_extractor_type).toBe("AI");
  });
});

// ── 7. Knowledge promotion requires approval ──

describe("7. knowledge promotion requires an approved receipt; superseded knowledge stays traceable", () => {
  it("no receipt → 409; approved receipt → knowledge_record with provenance; reject path; supersede chain", async () => {
    const company = await createCompany("Knowledge Co");
    const claim = await createClaimApi(company, { claim_text: "IC-relevant fact", claim_status: "FOUNDER_STATED" });

    const proposed = await handleRequest(
      req("/api/knowledge/promotion-candidates", MP, "POST", {
        candidate_type: "diligence_finding",
        payload: { title: "Finding: IC fact", body: "The fact, with context.", confidence: 0.9 },
        source_claim_ids: [claim.body.id],
      }),
      env,
    );
    expect(proposed.status).toBe(201);
    const candidate = (await proposed.json()) as { id: string; status: string; approval_card_id: string };
    expect(candidate.status).toBe("PENDING");
    expect(candidate.approval_card_id).toBeTruthy();

    // No receipt → refused.
    const noReceipt = await handleRequest(req(`/api/knowledge/promotion-candidates/${candidate.id}/apply`, MP, "POST", {}), env);
    expect(noReceipt.status).toBe(409);
    expect(((await noReceipt.json()) as { error: string }).error).toBe("approval_required");

    // Approve the card, then apply with the receipt.
    const decided = await handleRequest(req(`/api/approvals/${candidate.approval_card_id}/decide`, MP, "POST", { decision: "approved" }), env);
    expect(decided.status).toBe(200);
    const applied = await handleRequest(
      req(`/api/knowledge/promotion-candidates/${candidate.id}/apply`, MP, "POST", { approval_receipt_id: candidate.approval_card_id }),
      env,
    );
    expect(applied.status).toBe(201);
    const record = (await applied.json()) as { id: string; version_no: number; provenance_json: string; promoted_via_candidate_id: string };
    expect(record.version_no).toBe(1);
    expect(record.promoted_via_candidate_id).toBe(candidate.id);
    const provenance = JSON.parse(record.provenance_json) as { source_claim_ids: string[]; candidate_id: string; approval_card_id: string };
    expect(provenance.source_claim_ids).toEqual([claim.body.id]);
    expect(provenance.candidate_id).toBe(candidate.id);
    expect(provenance.approval_card_id).toBe(candidate.approval_card_id);

    // Receipt consumed → replay refused; candidate resolved.
    const replay = await handleRequest(
      req(`/api/knowledge/promotion-candidates/${candidate.id}/apply`, MP, "POST", { approval_receipt_id: candidate.approval_card_id }),
      env,
    );
    expect(replay.status).toBe(409);

    // Supersede chain: a new approved candidate creates version 2; version 1 stays readable.
    const proposed2 = await handleRequest(
      req("/api/knowledge/promotion-candidates", MP, "POST", {
        candidate_type: "diligence_finding",
        payload: { title: "Finding: IC fact (revised)", body: "Revised body.", supersedes_knowledge_id: record.id },
        source_claim_ids: [claim.body.id],
      }),
      env,
    );
    const candidate2 = (await proposed2.json()) as { id: string; approval_card_id: string };
    await handleRequest(req(`/api/approvals/${candidate2.approval_card_id}/decide`, MP, "POST", { decision: "approved" }), env);
    const applied2 = await handleRequest(
      req(`/api/knowledge/promotion-candidates/${candidate2.id}/apply`, MP, "POST", { approval_receipt_id: candidate2.approval_card_id }),
      env,
    );
    expect(applied2.status).toBe(201);
    const record2 = (await applied2.json()) as { id: string; version_no: number; supersedes_id: string };
    expect(record2.version_no).toBe(2);
    expect(record2.supersedes_id).toBe(record.id);

    const old = await handleRequest(req(`/api/knowledge/records/${record.id}`, MP), env);
    expect(old.status).toBe(200); // superseded knowledge remains readable (traceable)

    // Reject path: candidate → REJECTED, apply refused.
    const proposed3 = await handleRequest(
      req("/api/knowledge/promotion-candidates", MP, "POST", {
        candidate_type: "diligence_finding",
        payload: { title: "Rejected finding", body: "Will be rejected." },
        source_claim_ids: [claim.body.id],
      }),
      env,
    );
    const candidate3 = (await proposed3.json()) as { id: string };
    const rejected = await handleRequest(req(`/api/knowledge/promotion-candidates/${candidate3.id}/reject`, MP, "POST", {}), env);
    expect(rejected.status).toBe(200);
    expect(((await rejected.json()) as { status: string }).status).toBe("REJECTED");
    const applyRejected = await handleRequest(req(`/api/knowledge/promotion-candidates/${candidate3.id}/apply`, MP, "POST", {}), env);
    expect(applyRejected.status).toBe(409);

    const promoted = await t.db
      .prepare("SELECT * FROM event_record WHERE event_type = 'knowledge.promoted' AND object_id = ?1")
      .bind(record.id)
      .first();
    expect(promoted).not.toBeNull();
  });
});

// ── 8. Document round-trip + immutability + degraded mode ──

describe("8. document round-trip: R2 storage, SHA-256 integrity, version immutability, R2-absent 503", () => {
  it("upload → R2 → sha256 matches → download bytes identical; versions immutable by trigger", async () => {
    const content = "Diligence note: ARR $4.2M, burn $180k/mo.\nSecond line.";
    const uploaded = await handleRequest(
      req("/api/documents", MP, "POST", { title: "note.txt", doc_type: "diligence_note", content_base64: b64(content), content_type: "text/plain" }),
      env,
    );
    expect(uploaded.status).toBe(201);
    const doc = (await uploaded.json()) as { id: string; current_version_id: string; version: { sha256: string; size_bytes: number; r2_key: string } };
    expect(doc.version.sha256).toBe(sha256(content));
    expect(doc.version.size_bytes).toBe(Buffer.byteLength(content, "utf8"));

    // Bytes really are in R2 at the recorded key.
    const object = await t.docs.get(doc.version.r2_key);
    expect(object).not.toBeNull();
    expect(await object!.text()).toBe(content);

    // Download returns identical bytes + integrity headers.
    const download = await handleRequest(req(`/api/documents/${doc.id}/download`, MP), env);
    expect(download.status).toBe(200);
    expect(download.headers.get("x-content-sha256")).toBe(sha256(content));
    expect(await download.text()).toBe(content);

    // Version 2: both versions listed; old version still downloadable byte-identical.
    const v2content = "Revised note v2.";
    const v2 = await handleRequest(
      req(`/api/documents/${doc.id}/versions`, MP, "POST", { content_base64: b64(v2content), content_type: "text/plain" }),
      env,
    );
    expect(v2.status).toBe(201);
    const detail = (await (await handleRequest(req(`/api/documents/${doc.id}`, MP), env)).json()) as { versions: Array<{ version_no: number }> };
    expect(detail.versions.map((v) => v.version_no)).toEqual([1, 2]);
    const v1Download = await handleRequest(req(`/api/documents/${doc.id}/download?version=1`, MP), env);
    expect(await v1Download.text()).toBe(content);
    const v2Download = await handleRequest(req(`/api/documents/${doc.id}/download?version=2`, MP), env);
    expect(await v2Download.text()).toBe(v2content);

    // document_version is immutable at the database layer.
    await expect(t.db.prepare("UPDATE document_version SET sha256 = 'x'").run()).rejects.toThrow(/immutable/);
    await expect(t.db.prepare("DELETE FROM document_version").run()).rejects.toThrow(/immutable/);

    const uploadedEvent = await t.db
      .prepare("SELECT * FROM event_record WHERE event_type = 'document.uploaded' AND object_id = ?1")
      .bind(doc.id)
      .first();
    expect(uploadedEvent).not.toBeNull();
  });

  it("R2 binding absent → clean 503 with degraded-mode message (fail visible, §3.5)", async () => {
    const upload = await handleRequest(
      req("/api/documents", MP, "POST", { title: "x", doc_type: "y", content_base64: b64("hello"), content_type: "text/plain" }),
      envNoR2,
    );
    expect(upload.status).toBe(503);
    const body = (await upload.json()) as { error: string; detail: string };
    expect(body.error).toBe("documents_degraded");
    expect(body.detail).toContain("WP_OS_DOCUMENTS");

    // A stored document (from the R2-bound env) also degrades cleanly on download/extract.
    const fixture = await uploadFixture("degraded probe");
    const download = await handleRequest(req(`/api/documents/${fixture.documentId}/download`, MP), envNoR2);
    expect(download.status).toBe(503);
    const extract = await handleRequest(req("/api/claims/extract", MP, "POST", { document_version_id: fixture.versionId }), envNoR2);
    expect(extract.status).toBe(503);
  });
});

// ── 9. Source conflict resolution ──

describe("9. source conflict resolution: append-only decisions, resolver identity recorded", () => {
  it("create → resolve → decision row recorded; double resolve refused; decisions append-only by trigger", async () => {
    const created = await handleRequest(
      req("/api/source-conflicts", MP, "POST", {
        conflict_key: "crm-vs-network-os-email",
        system_a: "network_os",
        system_b: "west_peek_os",
        record_ref_a: "person/123",
        record_ref_b: "person/456",
        field: "email",
        value_a: "a@example.com",
        value_b: "b@example.com",
      }),
      env,
    );
    expect(created.status).toBe(201);
    const conflict = (await created.json()) as { id: string; status: string };
    expect(conflict.status).toBe("OPEN");

    // AI actors can never resolve.
    await expect(
      resolveSourceConflict(env, AI_ACTOR, conflict.id, { winning_source: "network_os", rationale: "ai attempt" }),
    ).rejects.toMatchObject({ status: 403 });

    const resolved = await handleRequest(
      req(`/api/source-conflicts/${conflict.id}/resolve`, MP, "POST", { winning_source: "network_os", rationale: "Network OS is authoritative for contact records (D5)." }),
      env,
    );
    expect(resolved.status).toBe(200);
    const resolvedBody = (await resolved.json()) as { status: string; resolved_by: string };
    expect(resolvedBody.status).toBe("RESOLVED");
    expect(resolvedBody.resolved_by).toBe("fu_scooter_taylor");

    const detail = (await (await handleRequest(req(`/api/source-conflicts/${conflict.id}`, MP), env)).json()) as {
      decisions: Array<{ winning_source: string; decided_by: string }>;
    };
    expect(detail.decisions).toHaveLength(1);
    expect(detail.decisions[0]).toMatchObject({ winning_source: "network_os", decided_by: "fu_scooter_taylor" });

    // Double resolution refused; decision rows are append-only at the DB layer.
    const again = await handleRequest(
      req(`/api/source-conflicts/${conflict.id}/resolve`, MP, "POST", { winning_source: "west_peek_os", rationale: "flip" }),
      env,
    );
    expect(again.status).toBe(409);
    await expect(t.db.prepare("UPDATE source_resolution_decision SET rationale = 'x'").run()).rejects.toThrow(/append-only/);
    await expect(t.db.prepare("DELETE FROM source_resolution_decision").run()).rejects.toThrow(/append-only/);
  });
});

// ── 10. Extraction fixture proof (mock-local adapter, offline) ──

describe("10. extraction fixture proof: /api/claims/extract end-to-end offline via the mock-local adapter", () => {
  it("fixture document → run through the boundary → AI_INFERRED candidates linked to the run", async () => {
    const company = await createCompany("Extraction Co");
    const fixtureText = [
      "ARR: $4.2M (2025)",
      "Gross margin: 78% (2025)",
      "Headcount: 23 (2025)",
      "This line has no metric shape and is ignored.",
    ].join("\n");
    const fixture = await uploadFixture(fixtureText, "metrics.txt");

    // Seeded default policy is LOCKDOWN → deterministic mock-local adapter, zero egress.
    const res = await handleRequest(req("/api/claims/extract", MP, "POST", { document_version_id: fixture.versionId, company_id: company }), env);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { run: { id: string; status: string; model: string | null; provider_id: string | null }; candidates: DiligenceClaimRow[] };
    expect(body.run.status).toBe("COMPLETED");
    expect(body.run.model).toBe("mock-local");
    expect(body.run.provider_id).toBeNull();
    expect(body.candidates).toHaveLength(3);

    for (const candidate of body.candidates) {
      expect(candidate.claim_status).toBe("AI_INFERRED");
      expect(candidate.extracted_by_type).toBe("AI");
      expect(candidate.ai_run_id).toBe(body.run.id);
      expect(candidate.company_id).toBe(company);
      const detail = (await (await handleRequest(req(`/api/claims/${candidate.id}`, MP), env)).json()) as { sources: Array<{ source_type: string; method: string; note: string }> };
      expect(detail.sources[0]!.source_type).toBe("MODEL_OUTPUT");
      expect(detail.sources[0]!.method).toBe("run_ai:mock-local");
    }

    // Deterministic parser: metric keys + periods pulled from the fixture lines.
    const parsed = parseClaimCandidates(fixtureText);
    expect(parsed.map((p) => p.metric_key)).toEqual(["arr", "gross_margin", "headcount"]);
    expect(parsed[0]).toMatchObject({ metric_value: "$4.2M (2025)", period_start: "2025-01-01", period_end: "2025-12-31" });

    // The extraction left typed spine events.
    const event = await t.db
      .prepare("SELECT COUNT(*) AS n FROM event_record WHERE event_type = 'claim.extracted'")
      .first<{ n: number }>();
    expect(event!.n).toBeGreaterThanOrEqual(3);
  });
});

// ── Spine completeness for material P5 mutations ──

describe("spine: material P5 mutations append typed events (D15)", () => {
  it("claim.created / contradiction.created / contradiction.resolved / source_conflict.created events exist", async () => {
    for (const type of ["claim.created", "contradiction.created", "contradiction.resolved", "source_conflict.created", "knowledge_promotion.proposed"]) {
      const row = await t.db.prepare("SELECT COUNT(*) AS n FROM event_record WHERE event_type = ?1").bind(type).first<{ n: number }>();
      expect(row!.n, type).toBeGreaterThanOrEqual(1);
    }
  });
});
