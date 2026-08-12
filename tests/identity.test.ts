import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { handleRequest } from "../src/worker/index";
import type { Env } from "../src/worker/env";

/**
 * P2 — canonical identity proofs: duplicate prevention, alias resolution,
 * legal-entity separation, candidates, human-reserved merge, exact reversal.
 */

let t: TestDb;
let env: Env;

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };
const MEMBER = { "x-wpos-dev-user": "member@westpeek.ventures" };

function req(
  path: string,
  headers: Record<string, string> = {},
  method = "GET",
  body?: unknown,
): Request {
  return new Request(`https://test.local${path}`, {
    method,
    headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function createCompany(body: unknown, headers = MP): Promise<Response> {
  return handleRequest(req("/api/companies", headers, "POST", body), env);
}

async function companyCount(): Promise<number> {
  const row = await t.db.prepare("SELECT COUNT(*) AS n FROM canonical_company").first<{ n: number }>();
  return row!.n;
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
  // A non-MP firm user (INVESTMENT_TEAM) to prove merge is MP-reserved.
  await t.db
    .prepare("INSERT INTO firm_user (id, email, full_name, status) VALUES ('fu_test_member', 'member@westpeek.ventures', 'Test Member', 'ACTIVE')")
    .run();
  await t.db
    .prepare("INSERT INTO firm_user_role (firm_user_id, role_id) VALUES ('fu_test_member', 'role_investment_team')")
    .run();
});

afterAll(async () => {
  await disposeTestDb(t);
});

describe("duplicate prevention across all three entry points", () => {
  it("rejects an exact canonical_name match (409 with the existing company)", async () => {
    const first = await createCompany({ canonical_name: "Acme Corp" });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { id: string };

    const dup = await createCompany({ canonical_name: "  ACME CORP" });
    expect(dup.status).toBe(409);
    const dupBody = (await dup.json()) as { error: string; reason: string; existing: { id: string } };
    expect(dupBody.error).toBe("duplicate");
    expect(dupBody.reason).toBe("canonical_name");
    expect(dupBody.existing.id).toBe(firstBody.id);
  });

  it("rejects an exact-alias match (existing alias and supplied-alias clashes)", async () => {
    const beta = await createCompany({ canonical_name: "Beta Corp", aliases: [{ alias: "Beta" }] });
    expect(beta.status).toBe(201);
    const betaId = ((await beta.json()) as { id: string }).id;

    // New company whose NAME collides with an existing alias.
    const byName = await createCompany({ canonical_name: "beta" });
    expect(byName.status).toBe(409);
    const byNameBody = (await byName.json()) as { reason: string; existing: { id: string } };
    expect(byNameBody.reason).toBe("alias");
    expect(byNameBody.existing.id).toBe(betaId);

    // New company whose supplied ALIAS collides with an existing alias.
    const byAlias = await createCompany({ canonical_name: "Beta Industries", aliases: [{ alias: "Beta" }] });
    expect(byAlias.status).toBe(409);
    expect(((await byAlias.json()) as { reason: string }).reason).toBe("alias");

    // New company whose supplied alias collides with an existing canonical name.
    const byCanon = await createCompany({ canonical_name: "Unrelated Co", aliases: [{ alias: "Beta Corp" }] });
    expect(byCanon.status).toBe(409);
  });

  it("rejects the same (system, external_key) external identity", async () => {
    const first = await createCompany({
      canonical_name: "Crunch Co",
      external_identities: [{ system: "crunchbase", external_key: "crunch-co" }],
    });
    expect(first.status).toBe(201);
    const firstId = ((await first.json()) as { id: string }).id;

    const dup = await createCompany({
      canonical_name: "Totally Different Name",
      external_identities: [{ system: "crunchbase", external_key: "crunch-co" }],
    });
    expect(dup.status).toBe(409);
    const body = (await dup.json()) as { reason: string; existing: { id: string } };
    expect(body.reason).toBe("external_identity");
    expect(body.existing.id).toBe(firstId);
  });
});

describe("alias resolution", () => {
  it("resolves a name to the one canonical company, via canonical name or alias", async () => {
    const created = await createCompany({ canonical_name: "Gamma Corp" });
    const company = (await created.json()) as { id: string };

    const addAlias = await handleRequest(
      req(`/api/companies/${company.id}/aliases`, MP, "POST", { alias: "Gamma" }),
      env,
    );
    expect(addAlias.status).toBe(201);

    const viaName = await handleRequest(req("/api/companies/resolve?name=Gamma%20Corp", MP), env);
    const viaNameBody = (await viaName.json()) as { match: { id: string }; matched_via: string };
    expect(viaNameBody.match.id).toBe(company.id);
    expect(viaNameBody.matched_via).toBe("canonical_name");

    const viaAlias = await handleRequest(req("/api/companies/resolve?name=gamma", MP), env);
    const viaAliasBody = (await viaAlias.json()) as { match: { id: string }; matched_via: string };
    expect(viaAliasBody.match.id).toBe(company.id);
    expect(viaAliasBody.matched_via).toBe("alias");

    const none = await handleRequest(req("/api/companies/resolve?name=No%20Such%20Company", MP), env);
    expect(((await none.json()) as { match: unknown }).match).toBeNull();
  });

  it("adding an alias never creates a company", async () => {
    const before = await companyCount();
    const companies = (await (
      await handleRequest(req("/api/companies", MP), env)
    ).json()) as { companies: Array<{ id: string }> };
    const target = companies.companies[0]!;
    const res = await handleRequest(
      req(`/api/companies/${target.id}/aliases`, MP, "POST", { alias: `alias-${target.id}` }),
      env,
    );
    expect(res.status).toBe(201);
    expect(await companyCount()).toBe(before);
  });
});

describe("legal-entity separation", () => {
  it("two companies with similar names remain distinct", async () => {
    const llc = await createCompany({ canonical_name: "Acme Holdings LLC" });
    const inc = await createCompany({ canonical_name: "Acme Holdings Inc" });
    expect(llc.status).toBe(201);
    expect(inc.status).toBe(201);
    const ids = [((await llc.json()) as { id: string }).id, ((await inc.json()) as { id: string }).id];
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("two fund entities with similar names remain distinct", async () => {
    const fund = await handleRequest(req("/api/funds", MP, "POST", { name: "Separation Test Fund" }), env);
    const fundId = ((await fund.json()) as { id: string }).id;

    const e1 = await handleRequest(
      req(`/api/funds/${fundId}/entities`, MP, "POST", {
        legal_entity_name: "Separation Test Fund LP",
        entity_type: "LIMITED_PARTNERSHIP",
        jurisdiction: "Delaware",
      }),
      env,
    );
    const e2 = await handleRequest(
      req(`/api/funds/${fundId}/entities`, MP, "POST", {
        legal_entity_name: "Separation Test Fund GP LLC",
        entity_type: "LLC",
        jurisdiction: "Delaware",
      }),
      env,
    );
    expect(e1.status).toBe(201);
    expect(e2.status).toBe(201);
    const ids = [((await e1.json()) as { id: string }).id, ((await e2.json()) as { id: string }).id];
    expect(ids[0]).not.toBe(ids[1]);

    const list = (await (
      await handleRequest(req(`/api/funds/${fundId}/entities`, MP), env)
    ).json()) as { entities: Array<{ id: string }> };
    expect(list.entities).toHaveLength(2);
  });
});

describe("identity resolution candidates", () => {
  it("creates, lists, accepts, rejects; accepting does NOT merge", async () => {
    const a = ((await (await createCompany({ canonical_name: "Candidate A" })).json()) as { id: string }).id;
    const b = ((await (await createCompany({ canonical_name: "Candidate B" })).json()) as { id: string }).id;

    const created = await handleRequest(
      req("/api/identity/candidates", MP, "POST", { company_id_a: a, company_id_b: b, match_basis: "same_domain", score: 0.82 }),
      env,
    );
    expect(created.status).toBe(201);
    const candidate = (await created.json()) as { id: string; status: string };
    expect(candidate.status).toBe("PENDING");

    const pending = (await (
      await handleRequest(req("/api/identity/candidates?status=PENDING", MP), env)
    ).json()) as { candidates: Array<{ id: string }> };
    expect(pending.candidates.map((c) => c.id)).toContain(candidate.id);

    const accepted = await handleRequest(req(`/api/identity/candidates/${candidate.id}/accept`, MP, "POST"), env);
    expect(accepted.status).toBe(200);
    const acceptedBody = (await accepted.json()) as { status: string; resolved_by: string; resolved_at: string };
    expect(acceptedBody.status).toBe("ACCEPTED");
    expect(acceptedBody.resolved_by).toBe("fu_scooter_taylor");
    expect(acceptedBody.resolved_at).toBeTruthy();

    // Accepting marks review outcome only — both companies remain ACTIVE and distinct.
    for (const id of [a, b]) {
      const company = (await (
        await handleRequest(req(`/api/companies/${id}`, MP), env)
      ).json()) as { status: string };
      expect(company.status).toBe("ACTIVE");
    }

    // Already-resolved candidates cannot be re-resolved.
    const again = await handleRequest(req(`/api/identity/candidates/${candidate.id}/reject`, MP, "POST"), env);
    expect(again.status).toBe(409);

    // Self-candidate is invalid.
    const self = await handleRequest(
      req("/api/identity/candidates", MP, "POST", { company_id_a: a, company_id_b: a, match_basis: "self" }),
      env,
    );
    expect(self.status).toBe(400);
  });
});

describe("merge + reversal (human-reserved, receipt-backed, P3 authorize() gate)", () => {
  let sourceId: string;
  let targetId: string;
  let thirdId: string;
  let receiptId: string;
  let preMergeState: Record<string, unknown[]>;

  /**
   * P3: identity_merge.execute is human-reserved — execution requires an approved
   * approval card (the authorization receipt) matching action + object. This helper
   * runs the approval flow as MP and returns the receipt id.
   */
  async function approvedMergeReceipt(objectType: string, objectId: string): Promise<string> {
    const created = await handleRequest(
      req("/api/approvals", MP, "POST", {
        action_key: "identity_merge.execute",
        object_type: objectType,
        object_id: objectId,
        title: `merge authority for ${objectId}`,
        submit: true,
      }),
      env,
    );
    expect(created.status).toBe(201);
    const card = (await created.json()) as { id: string };
    const decided = await handleRequest(
      req(`/api/approvals/${card.id}/decide`, MP, "POST", { decision: "approved", note: "MP merge authority" }),
      env,
    );
    expect(decided.status).toBe(200);
    return card.id;
  }

  /** Every row the merge could touch, keyed by table — the exact-reversal proof basis. */
  async function affectedState(): Promise<Record<string, unknown[]>> {
    const state: Record<string, unknown[]> = {};
    const companyRows = await t.db
      .prepare("SELECT * FROM canonical_company WHERE id IN (?1, ?2) ORDER BY id")
      .bind(sourceId, targetId)
      .all();
    state.canonical_company = companyRows.results ?? [];
    for (const [table, columns] of [
      ["company_alias", ["company_id"]],
      ["company_external_identity", ["company_id"]],
      ["organization_relationship", ["company_id"]],
      ["identity_resolution_candidate", ["company_id_a", "company_id_b"]],
    ] as Array<[string, string[]]>) {
      const where = columns.map((c) => `${c} IN (?1, ?2)`).join(" OR ");
      const rows = await t.db.prepare(`SELECT * FROM ${table} WHERE ${where} ORDER BY id`).bind(sourceId, targetId).all();
      state[table] = rows.results ?? [];
    }
    return state;
  }

  it("sets up a source company with references of every kind", async () => {
    sourceId = ((await (
      await createCompany({
        canonical_name: "Merge Source Co",
        aliases: [{ alias: "MergeSource" }],
        external_identities: [{ system: "crunchbase", external_key: "merge-source" }],
      })
    ).json()) as { id: string }).id;
    targetId = ((await (await createCompany({ canonical_name: "Merge Target Co" })).json()) as { id: string }).id;
    thirdId = ((await (await createCompany({ canonical_name: "Bystander Co" })).json()) as { id: string }).id;

    await t.db
      .prepare("INSERT INTO person (id, full_name, email) VALUES ('p_merge_test', 'Pat Person', 'pat@example.com')")
      .run();
    await t.db
      .prepare(
        "INSERT INTO organization_relationship (id, person_id, company_id, relationship_type) VALUES ('or_merge_test', 'p_merge_test', ?1, 'FOUNDER')",
      )
      .bind(sourceId)
      .run();
    await handleRequest(
      req("/api/identity/candidates", MP, "POST", { company_id_a: sourceId, company_id_b: thirdId, match_basis: "name_similarity" }),
      env,
    );

    const count = await t.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM company_alias WHERE company_id = ?1) +
           (SELECT COUNT(*) FROM company_external_identity WHERE company_id = ?1) +
           (SELECT COUNT(*) FROM organization_relationship WHERE company_id = ?1) +
           (SELECT COUNT(*) FROM identity_resolution_candidate WHERE company_id_a = ?1 OR company_id_b = ?1) AS n`,
      )
      .bind(sourceId)
      .first<{ n: number }>();
    expect(count!.n).toBe(4); // 1 alias + 1 external identity + 1 relationship + 1 candidate
  });

  it("denies merge to a non-MP actor (403) and changes nothing", async () => {
    const before = await affectedState();
    const res = await handleRequest(
      req(`/api/companies/${sourceId}/merge-into/${targetId}`, MEMBER, "POST"),
      env,
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { reason: string }).reason).toBe("missing_required_role");
    expect(await affectedState()).toEqual(before);
    const receipts = await t.db.prepare("SELECT COUNT(*) AS n FROM identity_merge_receipt").first<{ n: number }>();
    expect(receipts!.n).toBe(0);
  });

  it("requires an approval card even for an MP (409 approval_required without a receipt)", async () => {
    const res = await handleRequest(req(`/api/companies/${sourceId}/merge-into/${targetId}`, MP, "POST", {}), env);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; requiredApproverRoles: string[] };
    expect(body.error).toBe("approval_required");
    expect(body.requiredApproverRoles).toEqual(["MANAGING_PARTNER"]);
    // Nothing moved: the source is still ACTIVE and no merge receipt exists.
    const source = await t.db.prepare("SELECT status FROM canonical_company WHERE id = ?1").bind(sourceId).first<{ status: string }>();
    expect(source!.status).toBe("ACTIVE");
    const receipts = await t.db.prepare("SELECT COUNT(*) AS n FROM identity_merge_receipt").first<{ n: number }>();
    expect(receipts!.n).toBe(0);
  });

  it("allows merge for an MP with an approved receipt and writes a complete receipt (moved refs + snapshot + SHA-256)", async () => {
    preMergeState = await affectedState();

    const approvalReceipt = await approvedMergeReceipt("canonical_company", sourceId);
    const res = await handleRequest(
      req(`/api/companies/${sourceId}/merge-into/${targetId}`, MP, "POST", { approval_receipt_id: approvalReceipt }),
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      receipt: {
        id: string;
        source_company_id: string;
        target_company_id: string;
        actor_id: string;
        moved_references_json: string;
        pre_merge_snapshot_json: string;
        pre_merge_hash: string;
      };
      moved_references: Array<{ table: string; row_id: string; column: string; old_value: string; new_value: string }>;
    };
    receiptId = body.receipt.id;

    // Moved references: every affected row, with full old/new detail.
    expect(body.moved_references).toHaveLength(4);
    for (const m of body.moved_references) {
      expect(m.old_value).toBe(sourceId);
      expect(m.new_value).toBe(targetId);
      expect(m.row_id).toBeTruthy();
    }
    expect(new Set(body.moved_references.map((m) => m.table))).toEqual(
      new Set(["company_alias", "company_external_identity", "organization_relationship", "identity_resolution_candidate"]),
    );

    // Snapshot equals the actual pre-merge state; hash is its SHA-256 (Web Crypto).
    const snapshot = JSON.parse(body.receipt.pre_merge_snapshot_json) as Record<string, unknown[]>;
    expect(snapshot).toEqual(preMergeState);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body.receipt.pre_merge_snapshot_json));
    const expectedHash = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(body.receipt.pre_merge_hash).toBe(expectedHash);
    expect(body.receipt.pre_merge_hash).toMatch(/^[0-9a-f]{64}$/);

    // Source retired (never deleted); references now point at the target.
    const source = (await (
      await handleRequest(req(`/api/companies/${sourceId}`, MP), env)
    ).json()) as { status: string };
    expect(source.status).toBe("MERGED");
    const alias = await t.db.prepare("SELECT company_id FROM company_alias WHERE alias = 'MergeSource'").first<{ company_id: string }>();
    expect(alias!.company_id).toBe(targetId);
    const rel = await t.db.prepare("SELECT company_id FROM organization_relationship WHERE id = 'or_merge_test'").first<{ company_id: string }>();
    expect(rel!.company_id).toBe(targetId);

    // Event spine recorded the material mutation.
    const evt = await t.db
      .prepare("SELECT id, payload_json FROM event_record WHERE event_type = 'identity.company_merged' AND object_id = ?1")
      .bind(sourceId)
      .first<{ id: string; payload_json: string }>();
    expect(evt).toBeTruthy();
    expect(JSON.parse(evt!.payload_json)).toMatchObject({ merge_receipt_id: receiptId, target_company_id: targetId });

    // The authorization receipt was consumed by execution (approved → executed).
    const card = await t.db.prepare("SELECT state FROM approval_card WHERE id = ?1").bind(approvalReceipt).first<{ state: string }>();
    expect(card!.state).toBe("executed");
  });

  it("refuses a second merge of the already-MERGED source (409)", async () => {
    const approvalReceipt = await approvedMergeReceipt("canonical_company", sourceId);
    const res = await handleRequest(
      req(`/api/companies/${sourceId}/merge-into/${thirdId}`, MP, "POST", { approval_receipt_id: approvalReceipt }),
      env,
    );
    expect(res.status).toBe(409);
  });

  it("reversal restores every affected row EXACTLY (deep compare vs pre-merge state)", async () => {
    const approvalReceipt = await approvedMergeReceipt("identity_merge_receipt", receiptId);
    const res = await handleRequest(
      req(`/api/identity/merges/${receiptId}/reverse`, MP, "POST", { approval_receipt_id: approvalReceipt }),
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { restored_references: unknown[]; split_receipt: { id: string } };
    expect(body.restored_references).toHaveLength(4);

    // THE PROOF: post-reversal state equals pre-merge state for all affected rows.
    expect(await affectedState()).toEqual(preMergeState);

    // Split receipt + event written.
    const split = await t.db
      .prepare("SELECT * FROM identity_split_receipt WHERE merge_receipt_id = ?1")
      .bind(receiptId)
      .first<{ restored_company_id: string }>();
    expect(split!.restored_company_id).toBe(sourceId);
    const evt = await t.db
      .prepare("SELECT id FROM event_record WHERE event_type = 'identity.company_split' AND object_id = ?1")
      .bind(sourceId)
      .first();
    expect(evt).toBeTruthy();
  });

  it("refuses a double reversal (409)", async () => {
    const approvalReceipt = await approvedMergeReceipt("identity_merge_receipt", receiptId);
    const res = await handleRequest(
      req(`/api/identity/merges/${receiptId}/reverse`, MP, "POST", { approval_receipt_id: approvalReceipt }),
      env,
    );
    expect(res.status).toBe(409);
  });

  it("denies reversal to a non-MP actor (403)", async () => {
    // Fresh merge to reverse as non-MP.
    const s = ((await (await createCompany({ canonical_name: "Merge Source 2" })).json()) as { id: string }).id;
    const g = ((await (await createCompany({ canonical_name: "Merge Target 2" })).json()) as { id: string }).id;
    const mergeReceipt = await approvedMergeReceipt("canonical_company", s);
    const merged = await handleRequest(req(`/api/companies/${s}/merge-into/${g}`, MP, "POST", { approval_receipt_id: mergeReceipt }), env);
    const receipt = ((await merged.json()) as { receipt: { id: string } }).receipt;
    const res = await handleRequest(req(`/api/identity/merges/${receipt.id}/reverse`, MEMBER, "POST"), env);
    expect(res.status).toBe(403);
  });

  it("refuses reversal when a moved reference changed since merge (cannot restore exactly)", async () => {
    const s = ((await (
      await createCompany({ canonical_name: "Merge Source 3", aliases: [{ alias: "MS3" }] })
    ).json()) as { id: string }).id;
    const g = ((await (await createCompany({ canonical_name: "Merge Target 3" })).json()) as { id: string }).id;
    const mergeReceipt = await approvedMergeReceipt("canonical_company", s);
    const merged = await handleRequest(req(`/api/companies/${s}/merge-into/${g}`, MP, "POST", { approval_receipt_id: mergeReceipt }), env);
    const receipt = ((await merged.json()) as { receipt: { id: string } }).receipt;

    // Post-merge drift: repoint the moved alias elsewhere — reversal can no longer
    // restore the receipt exactly, so it must refuse and change nothing.
    await t.db.prepare("UPDATE company_alias SET company_id = ?1 WHERE alias = 'MS3'").bind(thirdId).run();
    const reverseReceipt = await approvedMergeReceipt("identity_merge_receipt", receipt.id);
    const res = await handleRequest(req(`/api/identity/merges/${receipt.id}/reverse`, MP, "POST", { approval_receipt_id: reverseReceipt }), env);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; conflicts: unknown[] };
    expect(body.error).toBe("conflict");
    expect(body.conflicts).toHaveLength(1);

    // Nothing restored: source stays MERGED, no split receipt written.
    const source = await t.db.prepare("SELECT status FROM canonical_company WHERE id = ?1").bind(s).first<{ status: string }>();
    expect(source!.status).toBe("MERGED");
    const split = await t.db.prepare("SELECT id FROM identity_split_receipt WHERE merge_receipt_id = ?1").bind(receipt.id).first();
    expect(split).toBeNull();
  });
});

describe("company read/update", () => {
  it("updates non-identity fields and rejects identity-field edits", async () => {
    const created = await createCompany({ canonical_name: "Update Co", website: "update.example.com" });
    const company = (await created.json()) as { id: string };

    const ok = await handleRequest(
      req(`/api/companies/${company.id}`, MP, "PATCH", { description: "updated", privacy_label: "CONFIDENTIAL" }),
      env,
    );
    expect(ok.status).toBe(200);
    const okBody = (await ok.json()) as { description: string; privacy_label: string; canonical_name: string };
    expect(okBody.description).toBe("updated");
    expect(okBody.privacy_label).toBe("CONFIDENTIAL");
    expect(okBody.canonical_name).toBe("Update Co");

    const bad = await handleRequest(
      req(`/api/companies/${company.id}`, MP, "PATCH", { canonical_name: "Rename Attempt" }),
      env,
    );
    expect(bad.status).toBe(400);
  });

  it("requires authentication on identity routes (401 when unauthenticated)", async () => {
    for (const [method, path] of [
      ["GET", "/api/companies"],
      ["POST", "/api/companies"],
      ["GET", "/api/identity/candidates"],
      ["POST", "/api/import/dry-run"],
    ] as Array<[string, string]>) {
      const res = await handleRequest(req(path, {}, method, method === "POST" ? {} : undefined), env);
      expect(res.status).toBe(401);
    }
  });
});
