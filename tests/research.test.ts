import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { handleRequest } from "../src/worker/index";
import type { Env } from "../src/worker/env";
import { claimSourceTypeFor } from "../src/worker/services/research";

/**
 * P21 — Research / Analyst Workstation (GAP-14).
 *
 * The rule this suite exists to hold: **research is not evidence**. A finding becomes
 * institutional truth only by promotion into the EXISTING P5 diligence-claim substrate, through
 * `createClaim`, carrying its source provenance and still subject to the self-promotion ban.
 *
 * Also under test: a reliability judgement must state what it rests on; a finding must cite a
 * source recorded on the same project; a packet's IC readiness is COMPUTED and refuses to claim
 * readiness while questions are open or findings are unpromoted; unresolved contradictions from
 * the firm's own P5 record travel with the packet rather than being filtered out.
 */

let t: TestDb;
let env: Env;

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };

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
async function makeCompany(): Promise<string> {
  seq += 1;
  const res = await call<{ id: string }>("/api/companies", MP, "POST", { canonical_name: `P21 Co ${seq} ${crypto.randomUUID().slice(0, 6)}` });
  expect(res.status).toBe(201);
  return res.body.id;
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
});

afterAll(async () => {
  await disposeTestDb(t);
});

describe("source kinds map onto the P5 claim vocabulary", () => {
  it("maps each research source kind to an existing claim source type", () => {
    expect(claimSourceTypeFor("DOCUMENT")).toBe("DOCUMENT");
    expect(claimSourceTypeFor("URL")).toBe("WEB");
    expect(claimSourceTypeFor("HUMAN")).toBe("HUMAN_STATEMENT");
    expect(claimSourceTypeFor("INTELLIGENCE_ITEM")).toBe("WEB");
    expect(claimSourceTypeFor("anything else")).toBe("OTHER");
  });
});

describe("a research project is a governed question, not a notebook", () => {
  it("opens with its question already recorded as an open question", async () => {
    const companyId = await makeCompany();
    const project = await call<{ id: string; status: string }>("/api/research/projects", MP, "POST", {
      title: "Secondaries pricing for Acme",
      question: "Is the offered block priced below the last primary?",
      company_id: companyId,
    });
    expect(project.status).toBe(201);
    expect(project.body.status).toBe("OPEN");

    const detail = await call<{ questions: Array<{ question: string; status: string }> }>(`/api/research/projects/${project.body.id}`, MP);
    expect(detail.body.questions).toHaveLength(1);
    expect(detail.body.questions[0]!.status).toBe("OPEN");
  });

  it("refuses to attach to a company that is not canonical (D3)", async () => {
    const res = await call("/api/research/projects", MP, "POST", {
      title: "Ghost research",
      question: "Does this company exist?",
      company_id: "cc_ghost",
    });
    expect(res.status).toBe(404);
  });

  it("states plainly that it holds no separate evidence store", async () => {
    const res = await call<{ rule: string }>("/api/research/projects", MP);
    expect(res.body.rule).toContain("no separate evidence store");
  });
});

describe("sources state their reliability and what it rests on", () => {
  it("refuses a reliability judgement with no stated basis", async () => {
    const companyId = await makeCompany();
    const project = await call<{ id: string }>("/api/research/projects", MP, "POST", {
      title: "Reliability probe",
      question: "How reliable is this?",
      company_id: companyId,
    });
    const res = await call(`/api/research/projects/${project.body.id}/sources`, MP, "POST", {
      kind: "URL",
      title: "An industry blog",
      url: "https://example.test/blog",
      reliability: "HIGH",
    });
    expect(res.status).toBe(400);
    expect((res.body as any).error).toBe("reliability_basis_required");
  });

  it("requires a DOCUMENT source to name the version it refers to", async () => {
    const project = await call<{ id: string }>("/api/research/projects", MP, "POST", { title: "Doc probe", question: "Which document?" });
    const res = await call(`/api/research/projects/${project.body.id}/sources`, MP, "POST", { kind: "DOCUMENT", title: "A data room file" });
    expect(res.status).toBe(400);
    expect((res.body as any).error).toBe("ref_required");
  });

  it("refuses a finding that cites a source from a different project", async () => {
    const a = await call<{ id: string }>("/api/research/projects", MP, "POST", { title: "Project A", question: "A?" });
    const b = await call<{ id: string }>("/api/research/projects", MP, "POST", { title: "Project B", question: "B?" });
    const source = await call<{ id: string }>(`/api/research/projects/${a.body.id}/sources`, MP, "POST", {
      kind: "HUMAN",
      title: "Call with an operator",
      reliability: "MEDIUM",
      reliability_basis: "first-hand, single source",
    });
    const res = await call(`/api/research/projects/${b.body.id}/findings`, MP, "POST", {
      source_id: source.body.id,
      statement: "Borrowed from another project",
    });
    expect(res.status).toBe(404);
  });
});

describe("promotion is the ONLY path from research to evidence", () => {
  it("promotes a finding into a governed UNVERIFIED claim carrying its provenance", async () => {
    const companyId = await makeCompany();
    const project = await call<{ id: string }>("/api/research/projects", MP, "POST", {
      title: "Acme growth",
      question: "What was ARR at the last close?",
      company_id: companyId,
    });
    const source = await call<{ id: string }>(`/api/research/projects/${project.body.id}/sources`, MP, "POST", {
      kind: "HUMAN",
      title: "Call with the CFO",
      reliability: "HIGH",
      reliability_basis: "first-hand from the person who owns the number",
    });
    const finding = await call<{ finding: { id: string; promoted_claim_id: string | null }; note: string }>(
      `/api/research/projects/${project.body.id}/findings`,
      MP,
      "POST",
      { source_id: source.body.id, statement: "ARR was $4.2m at the last close.", confidence: 0.8 },
    );
    expect(finding.status).toBe(201);
    expect(finding.body.finding.promoted_claim_id).toBeNull();
    expect(finding.body.note).toContain("not as evidence");

    // Before promotion, the firm's evidence substrate knows nothing about it.
    const before = await t.db.prepare("SELECT COUNT(*) AS n FROM diligence_claim WHERE company_id = ?1").bind(companyId).first<{ n: number }>();
    expect(before!.n).toBe(0);

    const promoted = await call<{ finding: { promoted_claim_id: string }; claim: { id: string; claim_status: string; confidence: number }; note: string }>(
      `/api/research/findings/${finding.body.finding.id}/promote`,
      MP,
      "POST",
      { subject_type: "company", metric_key: "arr", metric_value: "4200000" },
    );
    expect(promoted.status).toBe(201);
    expect(promoted.body.claim.claim_status).toBe("UNVERIFIED");
    expect(promoted.body.claim.confidence).toBeCloseTo(0.8);
    expect(promoted.body.note).toContain("Verification is a separate human act");

    // The claim is a REAL P5 claim with a real source row.
    const source_rows = await t.db.prepare("SELECT * FROM claim_source WHERE claim_id = ?1").bind(promoted.body.claim.id).all<{ source_type: string; method: string }>();
    expect((source_rows.results ?? [])).toHaveLength(1);
    expect(source_rows.results![0]!.source_type).toBe("HUMAN_STATEMENT");
    expect(source_rows.results![0]!.method).toContain("researcher-stated source reliability HIGH");

    const after = await t.db.prepare("SELECT COUNT(*) AS n FROM diligence_claim WHERE company_id = ?1").bind(companyId).first<{ n: number }>();
    expect(after!.n).toBe(1);
  });

  it("refuses to promote the same finding twice", async () => {
    const finding = await t.db.prepare("SELECT id FROM research_finding WHERE promoted_claim_id IS NOT NULL LIMIT 1").first<{ id: string }>();
    const res = await call(`/api/research/findings/${finding!.id}/promote`, MP, "POST", {});
    expect(res.status).toBe(409);
    expect((res.body as any).error).toBe("already_promoted");
  });

  it("keeps the finding statement immutable so evidence and research cannot drift apart", async () => {
    const finding = await t.db.prepare("SELECT id FROM research_finding LIMIT 1").first<{ id: string }>();
    await expect(
      t.db.prepare("UPDATE research_finding SET statement = 'rewritten after promotion' WHERE id = ?1").bind(finding!.id).run(),
    ).rejects.toThrow(/immutable/);
  });
});

describe("a project you cannot read is a project you cannot add to (final-review finding)", () => {
  it("refuses every mutation path on a RESTRICTED project for a user without the scope", async () => {
    await t.db
      .prepare("INSERT OR IGNORE INTO firm_user (id, email, full_name, status) VALUES ('fu_res_scopeless', 'res@westpeek.ventures', 'Research Reader', 'ACTIVE')")
      .run();
    await t.db
      .prepare("INSERT OR IGNORE INTO firm_user_role (firm_user_id, role_id) VALUES ('fu_res_scopeless', 'role_investment_team')")
      .run();
    const SCOPELESS = { "x-wpos-dev-user": "res@westpeek.ventures" };

    const project = await call<{ id: string; privacy_label: string }>("/api/research/projects", MP, "POST", {
      title: "Restricted diligence",
      question: "What does the restricted file say?",
      privacy_label: "RESTRICTED",
    });
    expect(project.body.privacy_label).toBe("RESTRICTED");

    // Read is hidden.
    expect((await call(`/api/research/projects/${project.body.id}`, SCOPELESS)).status).toBe(404);
    const list = await call<{ projects: any[] }>("/api/research/projects", SCOPELESS);
    expect(list.body.projects.some((p: any) => p.id === project.body.id)).toBe(false);

    // And so is every write.
    expect((await call(`/api/research/projects/${project.body.id}/questions`, SCOPELESS, "POST", { question: "sneak" })).status).toBe(404);
    expect(
      (await call(`/api/research/projects/${project.body.id}/sources`, SCOPELESS, "POST", { kind: "HUMAN", title: "sneak" })).status,
    ).toBe(404);
    expect(
      (await call(`/api/research/projects/${project.body.id}/findings`, SCOPELESS, "POST", { source_id: "rsrc_x", statement: "sneak" })).status,
    ).toBe(404);
    expect(
      (await call(`/api/research/projects/${project.body.id}/market-maps`, SCOPELESS, "POST", { name: "sneak", segments: [{ name: "s" }] })).status,
    ).toBe(404);
    expect((await call(`/api/research/projects/${project.body.id}/packets`, SCOPELESS, "POST", { title: "sneak" })).status).toBe(404);

    // Nothing was written on their behalf.
    const questions = await t.db.prepare("SELECT COUNT(*) AS n FROM research_question WHERE project_id = ?1").bind(project.body.id).first<{ n: number }>();
    expect(questions!.n).toBe(1); // only the opening question the MP created

    // Answering a question routes through its own project's visibility.
    const detail = await call<{ questions: Array<{ id: string }> }>(`/api/research/projects/${project.body.id}`, MP);
    const questionId = detail.body.questions[0]!.id;
    expect((await call(`/api/research/questions/${questionId}/answer`, SCOPELESS, "POST", { status: "ANSWERED", answer: "sneak" })).status).toBe(404);

    // The Managing Partner, who can see it, still can.
    expect((await call(`/api/research/projects/${project.body.id}/questions`, MP, "POST", { question: "a real follow-up" })).status).toBe(201);
  });

  it("refuses to promote a finding on a project the caller cannot read", async () => {
    const SCOPELESS = { "x-wpos-dev-user": "res@westpeek.ventures" };
    const project = await call<{ id: string }>("/api/research/projects", MP, "POST", {
      title: "Restricted promotion",
      question: "Promote me?",
      privacy_label: "RESTRICTED",
    });
    const source = await call<{ id: string }>(`/api/research/projects/${project.body.id}/sources`, MP, "POST", {
      kind: "HUMAN",
      title: "Restricted call",
      reliability: "HIGH",
      reliability_basis: "first-hand",
    });
    const finding = await call<{ finding: { id: string } }>(`/api/research/projects/${project.body.id}/findings`, MP, "POST", {
      source_id: source.body.id,
      statement: "A restricted finding.",
    });

    expect((await call(`/api/research/findings/${finding.body.finding.id}/promote`, SCOPELESS, "POST", {})).status).toBe(404);
    // Nothing entered the evidence substrate on their behalf.
    const row = await t.db.prepare("SELECT promoted_claim_id FROM research_finding WHERE id = ?1").bind(finding.body.finding.id).first<{ promoted_claim_id: string | null }>();
    expect(row!.promoted_claim_id).toBeNull();

    expect((await call(`/api/research/findings/${finding.body.finding.id}/promote`, MP, "POST", {})).status).toBe(201);
  });
});

describe("packets compute IC readiness rather than asserting it", () => {
  it("refuses to be IC-ready with an open question or an unpromoted finding, and says which", async () => {
    const companyId = await makeCompany();
    const project = await call<{ id: string }>("/api/research/projects", MP, "POST", {
      title: "Readiness probe",
      question: "Is this ready?",
      company_id: companyId,
    });
    const source = await call<{ id: string }>(`/api/research/projects/${project.body.id}/sources`, MP, "POST", {
      kind: "URL",
      title: "A filing",
      url: "https://example.test/filing",
      reliability: "MEDIUM",
      reliability_basis: "primary filing, but dated",
    });
    const finding = await call<{ finding: { id: string } }>(`/api/research/projects/${project.body.id}/findings`, MP, "POST", {
      source_id: source.body.id,
      statement: "Headcount was 40 at filing.",
    });

    const early = await call<{ ic_ready: number; ic_readiness_note: string }>(`/api/research/projects/${project.body.id}/packets`, MP, "POST", {
      title: "Early packet",
    });
    expect(early.status).toBe(201);
    expect(early.body.ic_ready).toBe(0);
    expect(early.body.ic_readiness_note).toContain("question(s) still open");
    expect(early.body.ic_readiness_note).toContain("not promoted into governed evidence");

    // Close the question and promote the finding, then re-assemble.
    const detail = await call<{ questions: Array<{ id: string; status: string }> }>(`/api/research/projects/${project.body.id}`, MP);
    const open = detail.body.questions.find((q) => q.status === "OPEN")!;
    await call(`/api/research/questions/${open.id}/answer`, MP, "POST", { status: "ANSWERED", answer: "Yes, with the filing caveat." });
    await call(`/api/research/findings/${finding.body.finding.id}/promote`, MP, "POST", {});

    const ready = await call<{ ic_ready: number; ic_readiness_note: string }>(`/api/research/projects/${project.body.id}/packets`, MP, "POST", {
      title: "Final packet",
    });
    expect(ready.body.ic_ready).toBe(1);
    expect(ready.body.ic_readiness_note).toContain("every finding is governed evidence");

    const packagedProject = await call<{ project: { status: string } }>(`/api/research/projects/${project.body.id}`, MP);
    expect(packagedProject.body.project.status).toBe("PACKAGED");
  });

  it("carries unresolved contradictions from the firm's own P5 record instead of filtering them", async () => {
    const companyId = await makeCompany();
    const project = await call<{ id: string }>("/api/research/projects", MP, "POST", {
      title: "Contradiction probe",
      question: "Which ARR figure is right?",
      company_id: companyId,
    });
    // Two findings that disagree, both promoted into governed claims, then contradicted through
    // the EXISTING P5 surface — which is exactly how a research disagreement is meant to travel.
    const source = await call<{ id: string }>(`/api/research/projects/${project.body.id}/sources`, MP, "POST", {
      kind: "HUMAN",
      title: "Two people, two numbers",
      reliability: "MEDIUM",
      reliability_basis: "two first-hand accounts that disagree",
    });
    const claimIds: string[] = [];
    for (const statement of ["ARR was $4.2m at the last close.", "ARR was $3.1m at the last close."]) {
      const finding = await call<{ finding: { id: string } }>(`/api/research/projects/${project.body.id}/findings`, MP, "POST", {
        source_id: source.body.id,
        statement,
      });
      const promoted = await call<{ claim: { id: string } }>(`/api/research/findings/${finding.body.finding.id}/promote`, MP, "POST", {});
      expect(promoted.status).toBe(201);
      claimIds.push(promoted.body.claim.id);
    }

    const contradiction = await call<{ id: string }>("/api/contradictions", MP, "POST", {
      contradiction_type: "VALUE",
      topic: "ARR disagreement",
      company_id: companyId,
      materiality: "HIGH",
      claim_links: [
        { claim_id: claimIds[0]!, side_label: "CFO call" },
        { claim_id: claimIds[1]!, side_label: "board deck" },
      ],
    });
    expect(contradiction.status).toBe(201);

    const packet = await call<{ contradictions_json: string; ic_readiness_note: string }>(
      `/api/research/projects/${project.body.id}/packets`,
      MP,
      "POST",
      { title: "Packet with a live disagreement" },
    );
    const carried = JSON.parse(packet.body.contradictions_json) as Array<{ topic: string }>;
    expect(carried.some((c) => c.topic === "ARR disagreement")).toBe(true);
    expect(packet.body.ic_readiness_note).toContain("unresolved contradiction");

    const detail = await call<{ open_contradictions: any[] }>(`/api/research/projects/${project.body.id}`, MP);
    expect(detail.body.open_contradictions.length).toBeGreaterThan(0);
  });

  it("keeps assembled packets immutable", async () => {
    const packet = await t.db.prepare("SELECT id FROM research_packet LIMIT 1").first<{ id: string }>();
    await expect(t.db.prepare("UPDATE research_packet SET ic_ready = 1 WHERE id = ?1").bind(packet!.id).run()).rejects.toThrow(/UPDATE rejected/);
  });
});
