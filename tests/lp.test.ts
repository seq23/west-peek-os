import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { handleRequest } from "../src/worker/index";
import type { Env } from "../src/worker/env";
import type { Actor } from "../src/worker/services/authorize";
import { accessLedger, draftLpClaim, publishLpClaim, submitLpClaim } from "../src/worker/services/lp";
import { runAi } from "../src/worker/ai/runAi";

/**
 * P10 — LP, fundraising, claims, and data-room control.
 *
 * Rules under test (plan §8/P10 + §12.2): an unsubstantiated LP claim can never be
 * submitted or published; publication needs BOTH approved evidence and an approved
 * `lp_marketing_claim.approve` receipt (consumed, never replayed); AI may draft but
 * never submits, approves, or publishes; only PUBLISHED claims may appear in shared
 * material; every share records recipient, artifact VERSION, permission, time, and
 * expiry in an append-only ledger with append-only revocations and computed
 * effective status; there is no automated LP outreach and no native VDR.
 *
 * Nothing here claims marketing, securities-law, or compliance sufficiency (§12.4):
 * live LP use remains a counsel/compliance gate.
 */

let t: TestDb;
let env: Env;

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };
const MEMBER = { "x-wpos-dev-user": "member@westpeek.ventures" };
const COMPLIANCE = { "x-wpos-dev-user": "compliance@westpeek.ventures" };

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

/**
 * A governed document version to cite. P5 refuses a DOCUMENT-sourced claim that does
 * not point at a real version in the governed store, so LP evidence must start here.
 */
async function governedDocumentVersion(label: string): Promise<string> {
  const uploaded = await call<{ version: { id: string } }>("/api/documents", MP, "POST", {
    title: label,
    doc_type: "administrator_statement",
    content_base64: btoa(`${label}\nFund I DPI 0.4x as of 2026-03-31\n`),
    content_type: "text/plain",
  });
  expect(uploaded.status).toBe(201);
  return uploaded.body.version.id;
}

/** A VERIFIED diligence claim — the only kind that substantiates an LP claim. */
async function verifiedEvidence(): Promise<string> {
  seq += 1;
  const company = await call<{ id: string }>("/api/companies", MP, "POST", { canonical_name: `P10 Co ${seq} ${crypto.randomUUID().slice(0, 8)}` });
  const claim = await call<{ id: string; claim_status: string }>("/api/claims", MP, "POST", {
    company_id: company.body.id,
    subject_type: "company",
    subject_id: company.body.id,
    claim_text: "Fund I DPI is 0.4x as of 2026-03-31",
    confidence: 0.9,
    claim_status: "VERIFIED",
    sources: [
      {
        source_type: "DOCUMENT",
        document_version_id: await governedDocumentVersion(`administrator statement ${seq}`),
        location: "administrator statement 2026-03-31, page 2",
        source_date: "2026-03-31",
        method: "administrator export",
      },
    ],
  });
  expect(claim.status).toBe(201);
  expect(claim.body.claim_status).toBe("VERIFIED");
  return claim.body.id;
}

/** An UNVERIFIED diligence claim — evidence that must not substantiate anything. */
async function unverifiedEvidence(): Promise<string> {
  seq += 1;
  const company = await call<{ id: string }>("/api/companies", MP, "POST", { canonical_name: `P10 Unverified ${seq} ${crypto.randomUUID().slice(0, 8)}` });
  const claim = await call<{ id: string; claim_status: string }>("/api/claims", MP, "POST", {
    company_id: company.body.id,
    subject_type: "company",
    subject_id: company.body.id,
    claim_text: "Founder says revenue tripled",
    confidence: 0.5,
    sources: [{ source_type: "HUMAN_STATEMENT", location: "call", source_date: "2026-02-02", method: "notes" }],
  });
  expect(claim.body.claim_status).toBe("UNVERIFIED");
  return claim.body.id;
}

async function approvedCard(actionKey: string, objectType: string, objectId: string, headers = MP): Promise<string> {
  const created = await call<{ id: string }>("/api/approvals", headers, "POST", {
    action_key: actionKey,
    object_type: objectType,
    object_id: objectId,
    title: `p10: ${actionKey} ${objectId}`,
    submit: true,
  });
  expect(created.status).toBe(201);
  const decided = await call(`/api/approvals/${created.body.id}/decide`, headers, "POST", { decision: "approved" });
  expect(decided.status).toBe(200);
  return created.body.id;
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db, { WP_OS_DOCUMENTS: t.docs });
  await t.db
    .prepare("INSERT INTO firm_user (id, email, full_name, status) VALUES ('fu_test_member', 'member@westpeek.ventures', 'Test Member', 'ACTIVE')")
    .run();
  await t.db.prepare("INSERT INTO firm_user_role (firm_user_id, role_id) VALUES ('fu_test_member', 'role_investment_team')").run();
  await t.db
    .prepare("INSERT INTO firm_user (id, email, full_name, status) VALUES ('fu_test_compliance', 'compliance@westpeek.ventures', 'Test Compliance', 'ACTIVE')")
    .run();
  await t.db.prepare("INSERT INTO firm_user_role (firm_user_id, role_id) VALUES ('fu_test_compliance', 'role_compliance_officer')").run();
});

afterAll(async () => {
  await disposeTestDb(t);
});

// ── 0. Unauthenticated requests are denied ──

describe("0. unauthenticated requests are denied (401) across the P10 surface", () => {
  it("returns 401 on every P10 route", async () => {
    const routes: Array<[string, string, unknown?]> = [
      ["POST", "/api/lp/records", {}],
      ["GET", "/api/lp/records"],
      ["GET", "/api/lp/records/lpr_x"],
      ["POST", "/api/lp/opportunities", {}],
      ["POST", "/api/lp/opportunities/lpo_x/transition", {}],
      ["POST", "/api/lp/opportunities/lpo_x/diligence-requests", {}],
      ["POST", "/api/lp/diligence-requests/lpd_x/respond", {}],
      ["POST", "/api/lp/claims", {}],
      ["GET", "/api/lp/claims"],
      ["GET", "/api/lp/claims/lpc_x"],
      ["POST", "/api/lp/claims/lpc_x/evidence", {}],
      ["POST", "/api/lp/claims/lpc_x/submit", {}],
      ["POST", "/api/lp/claims/lpc_x/reject", {}],
      ["POST", "/api/lp/claims/lpc_x/publish", {}],
      ["POST", "/api/lp/data-room/artifacts", {}],
      ["GET", "/api/lp/data-room/artifacts"],
      ["POST", "/api/lp/data-room/access", {}],
      ["GET", "/api/lp/data-room/access"],
      ["POST", "/api/lp/data-room/access/dar_x/revoke", {}],
    ];
    for (const [method, path, body] of routes) {
      const res = await handleRequest(req(path, {}, method, body), env);
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });
});

// ── 1. An unsubstantiated claim can never be published ──

describe("1. LP claims are evidence-backed or unpublishable", () => {
  it("refuses to submit a claim with no evidence at all", async () => {
    const claim = await call<{ id: string }>("/api/lp/claims", MP, "POST", { claim_text: "We are top-quartile", claim_type: "TRACK_RECORD" });
    expect(claim.status).toBe(201);
    const submitted = await call<{ error: string }>(`/api/lp/claims/${claim.body.id}/submit`, MP, "POST", {});
    expect(submitted.status).toBe(409);
    expect(submitted.body.error).toBe("unsubstantiated_claim");
  });

  it("refuses to submit when the linked evidence is not itself approved", async () => {
    const claim = await call<{ id: string }>("/api/lp/claims", MP, "POST", { claim_text: "Revenue tripled across the portfolio", claim_type: "PORTFOLIO" });
    const linked = await call<{ approved: boolean; reason: string }>(`/api/lp/claims/${claim.body.id}/evidence`, MP, "POST", {
      evidence_type: "DILIGENCE_CLAIM",
      evidence_ref_id: await unverifiedEvidence(),
    });
    expect(linked.status).toBe(201);
    expect(linked.body.approved).toBe(false);
    expect(linked.body.reason).toBe("claim_status:UNVERIFIED");

    const submitted = await call<{ error: string }>(`/api/lp/claims/${claim.body.id}/submit`, MP, "POST", {});
    expect(submitted.status).toBe(409);
    expect(submitted.body.error).toBe("unsubstantiated_claim");
  });

  it("refuses to publish without a receipt even when the evidence is approved", async () => {
    const claim = await call<{ id: string }>("/api/lp/claims", MP, "POST", { claim_text: "Fund I DPI is 0.4x", claim_type: "TRACK_RECORD" });
    await call(`/api/lp/claims/${claim.body.id}/evidence`, MP, "POST", { evidence_type: "DILIGENCE_CLAIM", evidence_ref_id: await verifiedEvidence() });
    const submitted = await call<{ approval_card_id: string }>(`/api/lp/claims/${claim.body.id}/submit`, MP, "POST", {});
    expect(submitted.status).toBe(200);
    const published = await call<{ error: string }>(`/api/lp/claims/${claim.body.id}/publish`, MP, "POST", {});
    expect(published.status).toBe(409);
    expect(published.body.error).toBe("approval_required");
  });

  it("publishes with approved evidence AND a compliance receipt, then refuses the replay", async () => {
    const claim = await call<{ id: string }>("/api/lp/claims", MP, "POST", { claim_text: "Fund I DPI is 0.4x as of 2026-03-31", claim_type: "TRACK_RECORD" });
    await call(`/api/lp/claims/${claim.body.id}/evidence`, MP, "POST", { evidence_type: "DILIGENCE_CLAIM", evidence_ref_id: await verifiedEvidence() });
    const submitted = await call<{ approval_card_id: string }>(`/api/lp/claims/${claim.body.id}/submit`, MP, "POST", {});

    // A COMPLIANCE_OFFICER is a valid approver for lp_marketing_claim.approve.
    const card = await call<{ required_approver_roles_json: string }>(`/api/approvals/${submitted.body.approval_card_id}`, MP);
    expect(JSON.parse(card.body.required_approver_roles_json)).toContain("COMPLIANCE_OFFICER");
    const decided = await call(`/api/approvals/${submitted.body.approval_card_id}/decide`, COMPLIANCE, "POST", { decision: "approved", note: "reviewed against the administrator statement" });
    expect(decided.status).toBe(200);

    const published = await call<{ status: string; published_at: string }>(`/api/lp/claims/${claim.body.id}/publish`, MP, "POST", {
      approval_receipt_id: submitted.body.approval_card_id,
    });
    expect(published.status).toBe(200);
    expect(published.body.status).toBe("PUBLISHED");
    expect(published.body.published_at).toBeTruthy();

    const replay = await call(`/api/lp/claims/${claim.body.id}/publish`, MP, "POST", { approval_receipt_id: submitted.body.approval_card_id });
    expect(replay.status).toBe(409);
  });

  it("a reviewer can REFUSE the language, and the claim stays revisable", async () => {
    const claim = await call<{ id: string }>("/api/lp/claims", MP, "POST", { claim_text: "We are consistently top-decile", claim_type: "TRACK_RECORD" });
    await call(`/api/lp/claims/${claim.body.id}/evidence`, MP, "POST", { evidence_type: "DILIGENCE_CLAIM", evidence_ref_id: await verifiedEvidence() });
    const submitted = await call<{ approval_card_id: string }>(`/api/lp/claims/${claim.body.id}/submit`, MP, "POST", {});
    expect(submitted.status).toBe(200);

    // Someone who could not have approved it cannot refuse it either.
    expect((await call(`/api/lp/claims/${claim.body.id}/reject`, MEMBER, "POST", { reason: "no" })).status).toBe(403);

    const rejected = await call<{ status: string }>(`/api/lp/claims/${claim.body.id}/reject`, COMPLIANCE, "POST", {
      reason: "‘consistently top-decile’ is not supported by the linked evidence",
    });
    expect(rejected.status).toBe(200);
    expect(rejected.body.status).toBe("REJECTED");

    // The pending card is resolved, not left dangling.
    const card = await call<{ state: string }>(`/api/approvals/${submitted.body.approval_card_id}`, MP);
    expect(card.body.state).toBe("rejected");
    // A rejected receipt can never publish.
    const published = await call(`/api/lp/claims/${claim.body.id}/publish`, MP, "POST", { approval_receipt_id: submitted.body.approval_card_id });
    expect(published.status).toBe(409);

    // The claim is NOT bricked: revised language goes back for a fresh review.
    const resubmitted = await call<{ approval_card_id: string }>(`/api/lp/claims/${claim.body.id}/submit`, MP, "POST", {});
    expect(resubmitted.status).toBe(200);
    expect(resubmitted.body.approval_card_id).not.toBe(submitted.body.approval_card_id);
    expect((await call(`/api/lp/claims/${claim.body.id}/reject`, MP, "POST", { reason: "x" })).status).toBe(200);
    // Rejecting something that is not under review is refused.
    expect((await call(`/api/lp/claims/${claim.body.id}/reject`, MP, "POST", { reason: "x" })).status).toBe(409);
  });

  it("refusing the CARD on the generic Approvals surface leaves the claim revisable too", async () => {
    // A reviewer works in Approvals, not in the LP surface: they reject the card
    // through /api/approvals/:id/decide, which knows nothing about lp_claim. The
    // claim must still be revisable, or that ordinary path strands it.
    const claim = await call<{ id: string }>("/api/lp/claims", MP, "POST", { claim_text: "Card-level refusal", claim_type: "TRACK_RECORD" });
    await call(`/api/lp/claims/${claim.body.id}/evidence`, MP, "POST", { evidence_type: "DILIGENCE_CLAIM", evidence_ref_id: await verifiedEvidence() });
    const submitted = await call<{ approval_card_id: string }>(`/api/lp/claims/${claim.body.id}/submit`, MP, "POST", {});

    // While the card is genuinely pending, resubmission is refused — no going around a live review.
    const early = await call<{ error: string }>(`/api/lp/claims/${claim.body.id}/submit`, MP, "POST", {});
    expect(early.status).toBe(409);
    expect(early.body.error).toBe("illegal_state");

    const decided = await call(`/api/approvals/${submitted.body.approval_card_id}/decide`, COMPLIANCE, "POST", {
      decision: "rejected",
      note: "not supported by the evidence",
    });
    expect(decided.status).toBe(200);

    // The claim row still reads PENDING_REVIEW, but review IS over, so it is revisable.
    const resubmitted = await call<{ approval_card_id: string }>(`/api/lp/claims/${claim.body.id}/submit`, MP, "POST", {});
    expect(resubmitted.status).toBe(200);
    expect(resubmitted.body.approval_card_id).not.toBe(submitted.body.approval_card_id);
    // The stale rejected receipt can never publish.
    expect((await call(`/api/lp/claims/${claim.body.id}/publish`, MP, "POST", { approval_receipt_id: submitted.body.approval_card_id })).status).toBe(409);
  });

  it("revise_requested on the card is also treated as review being over", async () => {
    const claim = await call<{ id: string }>("/api/lp/claims", MP, "POST", { claim_text: "Revise requested", claim_type: "STRATEGY" });
    await call(`/api/lp/claims/${claim.body.id}/evidence`, MP, "POST", { evidence_type: "DILIGENCE_CLAIM", evidence_ref_id: await verifiedEvidence() });
    const submitted = await call<{ approval_card_id: string }>(`/api/lp/claims/${claim.body.id}/submit`, MP, "POST", {});
    await call(`/api/approvals/${submitted.body.approval_card_id}/decide`, COMPLIANCE, "POST", { decision: "revise_requested", note: "soften the wording" });
    expect((await call(`/api/lp/claims/${claim.body.id}/submit`, MP, "POST", {})).status).toBe(200);
  });

  it("an AI can never refuse an LP claim either", async () => {
    const { rejectLpClaim } = await import("../src/worker/services/lp");
    const claim = await call<{ id: string }>("/api/lp/claims", MP, "POST", { claim_text: "AI cannot decide this", claim_type: "STRATEGY" });
    await call(`/api/lp/claims/${claim.body.id}/evidence`, MP, "POST", { evidence_type: "DILIGENCE_CLAIM", evidence_ref_id: await verifiedEvidence() });
    await call(`/api/lp/claims/${claim.body.id}/submit`, MP, "POST", {});
    await expect(rejectLpClaim(env, AI_ACTOR, claim.body.id, "no")).rejects.toMatchObject({ status: 403 });
  });

  it("evidence that decays between review and publication blocks the publish", async () => {
    const evidenceId = await verifiedEvidence();
    const claim = await call<{ id: string }>("/api/lp/claims", MP, "POST", { claim_text: "Our net TVPI leads the vintage", claim_type: "TRACK_RECORD" });
    await call(`/api/lp/claims/${claim.body.id}/evidence`, MP, "POST", { evidence_type: "DILIGENCE_CLAIM", evidence_ref_id: evidenceId });
    const submitted = await call<{ approval_card_id: string }>(`/api/lp/claims/${claim.body.id}/submit`, MP, "POST", {});
    await call(`/api/approvals/${submitted.body.approval_card_id}/decide`, MP, "POST", { decision: "approved" });

    // The supporting claim is superseded before publication.
    const original = await call<{ company_id: string; subject_type: string; subject_id: string }>(`/api/claims/${evidenceId}`, MP);
    const superseded = await call(`/api/claims/${evidenceId}/supersede`, MP, "POST", {
      company_id: original.body.company_id,
      subject_type: original.body.subject_type,
      subject_id: original.body.subject_id,
      claim_text: "Fund I DPI restated to 0.35x",
      confidence: 0.9,
      sources: [
        {
          source_type: "DOCUMENT",
          document_version_id: await governedDocumentVersion("restated administrator statement"),
          location: "restated statement 2026-04-30, page 1",
          source_date: "2026-04-30",
          method: "administrator export",
        },
      ],
    });
    expect(superseded.status).toBe(201);

    const published = await call<{ error: string }>(`/api/lp/claims/${claim.body.id}/publish`, MP, "POST", {
      approval_receipt_id: submitted.body.approval_card_id,
    });
    expect(published.status).toBe(409);
    expect(published.body.error).toBe("unsubstantiated_claim");
  });
});

// ── 2. AI drafts only ──

describe("2. an AI drafts LP language and nothing else", () => {
  it("requires a run trace to draft, and can never submit or publish", async () => {
    await expect(draftLpClaim(env, AI_ACTOR, { claim_text: "We are the best fund", claim_type: "STRATEGY" })).rejects.toMatchObject({ status: 400 });
    const run = await runAi(env, { purpose: "lp_material_draft", actor: AI_ACTOR, inputs: ["draft a strategy paragraph"], sensitivity: "INTERNAL" });
    const claim = await draftLpClaim(env, AI_ACTOR, { claim_text: "Our sourcing is relationship-led", claim_type: "STRATEGY", ai_run_id: run.run.id });
    expect(claim.drafted_by_type).toBe("AI");
    expect(claim.status).toBe("DRAFT");

    await expect(submitLpClaim(env, AI_ACTOR, claim.id)).rejects.toMatchObject({ status: 403 });
    await expect(publishLpClaim(env, AI_ACTOR, claim.id)).rejects.toMatchObject({ status: 403 });
  });

  it("an LP promise remains a human-reserved action an AI is denied outright", async () => {
    const { authorize } = await import("../src/worker/services/authorize");
    const aiDecision = await authorize(env, AI_ACTOR, "lp.promise", { objectType: "lp_record", firmScope: "west-peek" });
    expect(aiDecision.decision).toBe("DENY");
    const mpDecision = await authorize(env, MP_ACTOR, "lp.promise", { objectType: "lp_record", firmScope: "west-peek" });
    expect(mpDecision.decision).toBe("REQUIRE_APPROVAL");
    const memberDecision = await authorize(env, MEMBER_ACTOR, "lp.promise", { objectType: "lp_record", firmScope: "west-peek" });
    expect(memberDecision.decision).toBe("DENY");
  });
});

// ── 3. Data room: versioned sharing, access ledger, revocation ──

describe("3. shared material is versioned, gated, logged, and revocable", () => {
  async function publishedClaim(text: string): Promise<string> {
    const claim = await call<{ id: string }>("/api/lp/claims", MP, "POST", { claim_text: text, claim_type: "TRACK_RECORD" });
    await call(`/api/lp/claims/${claim.body.id}/evidence`, MP, "POST", { evidence_type: "DILIGENCE_CLAIM", evidence_ref_id: await verifiedEvidence() });
    const submitted = await call<{ approval_card_id: string }>(`/api/lp/claims/${claim.body.id}/submit`, MP, "POST", {});
    await call(`/api/approvals/${submitted.body.approval_card_id}/decide`, MP, "POST", { decision: "approved" });
    const published = await call(`/api/lp/claims/${claim.body.id}/publish`, MP, "POST", { approval_receipt_id: submitted.body.approval_card_id });
    expect(published.status).toBe(200);
    return claim.body.id;
  }

  it("refuses to attach an unpublished claim to shared material", async () => {
    const draft = await call<{ id: string }>("/api/lp/claims", MP, "POST", { claim_text: "unreviewed language", claim_type: "STRATEGY" });
    const artifact = await call<{ error: string }>("/api/lp/data-room/artifacts", MP, "POST", {
      title: `Deck ${crypto.randomUUID().slice(0, 6)}`,
      lp_claim_ids: [draft.body.id],
    });
    expect(artifact.status).toBe(409);
    expect(artifact.body.error).toBe("unpublished_claim");
  });

  it("records recipient, version, permission, time, and expiry — and refuses without the send receipt", async () => {
    const claimId = await publishedClaim("Fund I DPI is 0.4x (deck page 4)");
    const title = `LP Deck ${crypto.randomUUID().slice(0, 6)}`;
    const v1 = await call<{ id: string; version: number }>("/api/lp/data-room/artifacts", MP, "POST", {
      title,
      version: 1,
      lp_claim_ids: [claimId],
      status: "READY",
      provider_ref: "external-vdr://folder/deck-v1",
    });
    expect(v1.status).toBe(201);

    const lp = await call<{ id: string }>("/api/lp/records", MP, "POST", { legal_name: "Example Family Office", lp_type: "FAMILY_OFFICE" });

    const noReceipt = await call<{ error: string }>("/api/lp/data-room/access", MP, "POST", {
      artifact_id: v1.body.id,
      recipient_label: "cio@example.com",
      permission: "VIEW",
      lp_record_id: lp.body.id,
    });
    expect(noReceipt.status).toBe(409);
    expect(noReceipt.body.error).toBe("approval_required");

    const receipt = await approvedCard("lp_sensitive_communication.send", "data_room_artifact", v1.body.id);
    const granted = await call<{ id: string; artifact_version: number; permission: string; expires_at: string; approval_card_id: string }>(
      "/api/lp/data-room/access",
      MP,
      "POST",
      {
        artifact_id: v1.body.id,
        recipient_label: "cio@example.com",
        recipient_ref: "lp_contact_1",
        permission: "VIEW",
        lp_record_id: lp.body.id,
        expires_at: "2099-01-01T00:00:00.000Z",
        external_vdr_ref: "external-vdr://share/abc",
        // The receipt is PRESENTED, never discovered: authorize() never goes looking
        // for a card that happens to match.
        approval_receipt_id: receipt,
      },
    );
    expect(granted.status).toBe(201);
    expect(granted.body.artifact_version).toBe(1);
    expect(granted.body.permission).toBe("VIEW");
    expect(granted.body.approval_card_id).toBe(receipt);

    // A second, later VERSION is shared separately — versions never blur together.
    const v2 = await call<{ id: string; version: number }>("/api/lp/data-room/artifacts", MP, "POST", {
      title,
      version: 2,
      lp_claim_ids: [claimId],
      status: "READY",
      provider_ref: "external-vdr://folder/deck-v2",
    });
    const receipt2 = await approvedCard("lp_sensitive_communication.send", "data_room_artifact", v2.body.id);
    const granted2 = await call<{ artifact_version: number }>("/api/lp/data-room/access", MP, "POST", {
      artifact_id: v2.body.id,
      recipient_label: "cio@example.com",
      permission: "DOWNLOAD",
      approval_receipt_id: receipt2,
    });
    expect(granted2.body.artifact_version).toBe(2);

    const ledger = await call<{ access_records: Array<{ id: string; artifact_version: number; effective_status: string; recipient_label: string }> }>(
      "/api/lp/data-room/access",
      MP,
    );
    const mine = ledger.body.access_records.filter((r) => r.recipient_label === "cio@example.com");
    expect(mine).toHaveLength(2);
    expect(mine.every((r) => r.effective_status === "ACTIVE")).toBe(true);

    // Revocation is recorded and flips the effective status; grants are never edited.
    const revoked = await call(`/api/lp/data-room/access/${granted.body.id}/revoke`, MP, "POST", { reason: "engagement ended" });
    expect(revoked.status).toBe(201);
    const after = await accessLedger(env);
    expect(after.find((r) => r.id === granted.body.id)!.effective_status).toBe("REVOKED");
    const again = await call(`/api/lp/data-room/access/${granted.body.id}/revoke`, MP, "POST", { reason: "again" });
    expect(again.status).toBe(409);

    await expect(t.db.prepare("UPDATE data_room_access_record SET permission = 'DOWNLOAD' WHERE id = ?1").bind(granted.body.id).run()).rejects.toThrow(/append-only/);
    await expect(t.db.prepare("DELETE FROM data_room_access_record WHERE id = ?1").bind(granted.body.id).run()).rejects.toThrow(/append-only/);
  });

  it("an expired grant reads as EXPIRED without anyone editing the record", async () => {
    const claimId = await publishedClaim("Portfolio construction language");
    const artifact = await call<{ id: string }>("/api/lp/data-room/artifacts", MP, "POST", {
      title: `Expiring ${crypto.randomUUID().slice(0, 6)}`,
      lp_claim_ids: [claimId],
      status: "READY",
    });
    const receipt = await approvedCard("lp_sensitive_communication.send", "data_room_artifact", artifact.body.id);
    const granted = await call<{ id: string }>("/api/lp/data-room/access", MP, "POST", {
      artifact_id: artifact.body.id,
      recipient_label: "expiring@example.com",
      permission: "VIEW",
      expires_at: "2020-01-01T00:00:00.000Z",
      approval_receipt_id: receipt,
    });
    const ledger = await accessLedger(env);
    expect(ledger.find((r) => r.id === granted.body.id)!.effective_status).toBe("EXPIRED");
  });

  it("DRAFT material cannot be shared at all", async () => {
    const artifact = await call<{ id: string }>("/api/lp/data-room/artifacts", MP, "POST", { title: `Draft ${crypto.randomUUID().slice(0, 6)}` });
    const receipt = await approvedCard("lp_sensitive_communication.send", "data_room_artifact", artifact.body.id);
    const res = await call<{ error: string }>("/api/lp/data-room/access", MP, "POST", {
      artifact_id: artifact.body.id,
      recipient_label: "x@example.com",
      permission: "VIEW",
      approval_receipt_id: receipt,
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("artifact_not_ready");
  });

  it("the VDR stays external: no route serves data-room bytes and the state is labelled", async () => {
    const artifacts = await call<{ vdr_state: string }>("/api/lp/data-room/artifacts", MP);
    expect(artifacts.body.vdr_state).toContain("UNPROVEN");
    expect(artifacts.body.vdr_state).toContain("PROVIDER NOT SELECTED");
    // There is no download/serve route under the LP surface.
    for (const path of ["/api/lp/data-room/artifacts/dra_x/download", "/api/lp/data-room/artifacts/dra_x/content"]) {
      const res = await handleRequest(req(path, MP), env);
      expect(res.status, path).toBe(404);
    }
  });
});

// ── 4. LP workflow, privacy, and outreach ──

describe("4. LP workflow stays governed and private", () => {
  it("moves through governed stages and refuses illegal jumps", async () => {
    const lp = await call<{ id: string }>("/api/lp/records", MP, "POST", { legal_name: "Stage LP", lp_type: "INSTITUTION" });
    const opportunity = await call<{ id: string; stage: string }>("/api/lp/opportunities", MP, "POST", { lp_record_id: lp.body.id, target_commitment: 5_000_000 });
    expect(opportunity.body.stage).toBe("INTRODUCED");
    const illegal = await call<{ error: string }>(`/api/lp/opportunities/${opportunity.body.id}/transition`, MP, "POST", { to: "COMMITTED" });
    expect(illegal.status).toBe(409);
    for (const to of ["MATERIALS_SHARED", "DILIGENCE", "TERMS", "COMMITTED"]) {
      const res = await call(`/api/lp/opportunities/${opportunity.body.id}/transition`, MP, "POST", { to });
      expect(res.status, to).toBe(200);
    }
    const terminal = await call(`/api/lp/opportunities/${opportunity.body.id}/transition`, MP, "POST", { to: "PASSED" });
    expect(terminal.status).toBe(409);
  });

  it("records LP diligence requests and human responses", async () => {
    const lp = await call<{ id: string }>("/api/lp/records", MP, "POST", { legal_name: "Diligence LP", lp_type: "FUND_OF_FUNDS" });
    const opportunity = await call<{ id: string }>("/api/lp/opportunities", MP, "POST", { lp_record_id: lp.body.id });
    const request = await call<{ id: string; status: string }>(`/api/lp/opportunities/${opportunity.body.id}/diligence-requests`, MP, "POST", {
      request_text: "Please provide the audited financials for Fund I",
      requested_at: "2026-05-01",
      due_date: "2026-05-15",
    });
    expect(request.status).toBe(201);
    const responded = await call<{ status: string; responded_by: string }>(`/api/lp/diligence-requests/${request.body.id}/respond`, MP, "POST", {
      response_note: "Shared via the external data room under a recorded grant",
    });
    expect(responded.body.status).toBe("ANSWERED");
    expect(responded.body.responded_by).toBe("fu_scooter_taylor");
    const again = await call(`/api/lp/diligence-requests/${request.body.id}/respond`, MP, "POST", { response_note: "x" });
    expect(again.status).toBe(409);
  });

  it("LP records are LP_PRIVATE: invisible to a firm user without that scope", async () => {
    const lp = await call<{ id: string }>("/api/lp/records", MP, "POST", { legal_name: "Private LP", lp_type: "INDIVIDUAL" });
    const asMember = await call<{ lp_records: unknown[] }>("/api/lp/records", MEMBER);
    expect(asMember.body.lp_records).toHaveLength(0);
    const read = await call(`/api/lp/records/${lp.body.id}`, MEMBER);
    expect(read.status).toBe(404);
    const asMp = await call(`/api/lp/records/${lp.body.id}`, MP);
    expect(asMp.status).toBe(200);
  });

  it("there is no automated LP outreach: sending anything still needs the P3 effect receipt", async () => {
    const effect = await call<{ id: string }>("/api/effects/requests", MP, "POST", {
      effect_type: "email.send",
      destination: "cio@example.com",
      payload: { subject: "Fund II materials" },
    });
    expect(effect.status).toBe(201);
    const blocked = await call<{ error: string }>(`/api/effects/requests/${effect.body.id}/execute`, MP, "POST", {});
    expect(blocked.status).toBe(409);
    // Nothing in the LP surface executes an effect on its own.
    const executed = await t.db.prepare("SELECT COUNT(*) AS n FROM external_effect_request WHERE state = 'EXECUTED'").first<{ n: number }>();
    expect(executed!.n).toBe(0);
  });

  it("the journey leaves typed lp.* events on the ONE spine (D15)", async () => {
    const events = await t.db.prepare("SELECT DISTINCT event_type FROM event_record WHERE event_type LIKE 'lp.%'").all<{ event_type: string }>();
    const types = new Set((events.results ?? []).map((e) => e.event_type));
    for (const expected of [
      "lp.record_created",
      "lp.opportunity_created",
      "lp.claim_drafted",
      "lp.claim_submitted",
      "lp.claim_published",
      "lp.data_room_access_granted",
      "lp.data_room_access_revoked",
    ]) {
      expect(types, expected).toContain(expected);
    }
  });
});

// ── What an LP actually committed ──

describe("the fund can record what an LP committed, and how big it is", () => {
  /**
   * Operator, on the LP page: "i have no idea what a claim is." The vocabulary was the smaller
   * half — there was nowhere in this system to record how much money an LP had committed, or the
   * fund's size. "COMMITTED" existed only as a status string on three different tables, so the
   * system could say an LP had committed while holding no idea what to, or how much.
   */
  let fundId = "";
  let lpA = "";
  let lpB = "";

  it("sets the fund's target, which is the one number a partner states rather than derives", async () => {
    const f = await call<{ id: string }>("/api/funds", MP, "POST", { name: "West Peek Fund I" });
    expect(f.status).toBe(201);
    fundId = f.body.id;

    const res = await call(`/api/funds/${fundId}/size`, MP, "PATCH", { target_size: 30_000_000, vintage_year: 2026 });
    expect(res.status).toBe(200);
  });

  it("records a commitment against a real LP and a real fund", async () => {
    const a = await call<{ id: string }>("/api/lp/records", MP, "POST", { legal_name: "Cedar Family Office", lp_type: "FAMILY_OFFICE" });
    const b = await call<{ id: string }>("/api/lp/records", MP, "POST", { legal_name: "Meridian Endowment", lp_type: "INSTITUTION" });
    lpA = a.body.id;
    lpB = b.body.id;

    expect((await call(`/api/lp/commitments`, MP, "POST", { lp_record_id: lpA, fund_id: fundId, amount: 5_000_000, state: "SIGNED" })).status).toBe(201);
    expect((await call(`/api/lp/commitments`, MP, "POST", { lp_record_id: lpB, fund_id: fundId, amount: 2_000_000, state: "SOFT" })).status).toBe(201);
  });

  it("keeps signed and soft apart, because one is banked and the other is hoped", async () => {
    const res = await call<{ funds: Array<{ target: number; signed: number; soft: number; percent_of_target: number }> }>("/api/lp/fundraising", MP);
    const f = res.body.funds.find((x: any) => x.id === fundId)!;
    expect(f.target).toBe(30_000_000);
    expect(f.signed).toBe(5_000_000);
    expect(f.soft).toBe(2_000_000);
    // Never added together into one "raised" figure — that is what removes the distinction.
    expect(f.percent_of_target).toBe(16.7);
  });

  it("revises rather than duplicating, so the fund's total cannot double-count", async () => {
    const again = await call(`/api/lp/commitments`, MP, "POST", { lp_record_id: lpA, fund_id: fundId, amount: 8_000_000, state: "SIGNED" });
    expect(again.status).toBe(200);

    const res = await call<{ funds: Array<{ signed: number; signed_count: number }> }>("/api/lp/fundraising", MP);
    const f = res.body.funds.find((x: any) => x.id === fundId)!;
    expect(f.signed).toBe(8_000_000);
    expect(f.signed_count).toBe(1);
  });

  it("keeps money exact — no float drift on the number that ends up in an LP letter", async () => {
    const cents = await call(`/api/lp/commitments`, MP, "POST", { lp_record_id: lpB, fund_id: fundId, amount: 1_234_567.89, state: "SIGNED" });
    expect(cents.status).toBe(200);
    const res = await call<{ commitments: Array<{ lp_record_id: string; amount: number }> }>("/api/lp/commitments", MP);
    const row = res.body.commitments.find((c) => c.lp_record_id === lpB)!;
    expect(row.amount).toBe(1_234_567.89);
  });

  it("refuses a commitment to an LP or a fund that does not exist", async () => {
    expect((await call("/api/lp/commitments", MP, "POST", { lp_record_id: "lp_nope", fund_id: fundId, amount: 1 })).status).toBe(404);
    expect((await call("/api/lp/commitments", MP, "POST", { lp_record_id: lpA, fund_id: "fund_nope", amount: 1 })).status).toBe(404);
  });

  it("has no percentage when nobody has said what the fund is raising", async () => {
    const f2 = await call<{ id: string }>("/api/funds", MP, "POST", { name: "West Peek Opportunities" });
    const res = await call<{ funds: Array<{ id: string; target: null; percent_of_target: null }> }>("/api/lp/fundraising", MP);
    const f = res.body.funds.find((x: any) => x.id === f2.body.id)!;
    // Not zero per cent. A percentage of nothing is a question nobody has answered yet.
    expect(f.target).toBeNull();
    expect(f.percent_of_target).toBeNull();
  });
});
