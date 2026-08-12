import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { handleRequest } from "../src/worker/index";
import type { Env } from "../src/worker/env";

/**
 * P2 — import contract proofs: DRY-RUN validates the contract, reports what WOULD
 * be created/conflict, and persists NOTHING. Invalid payloads are 400.
 */

let t: TestDb;
let env: Env;

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };

function req(path: string, method = "GET", body?: unknown): Request {
  return new Request(`https://test.local${path}`, {
    method,
    headers: body === undefined ? MP : { ...MP, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function rowCounts(): Promise<{ companies: number; persons: number; aliases: number; events: number }> {
  const c = await t.db.prepare("SELECT COUNT(*) AS n FROM canonical_company").first<{ n: number }>();
  const p = await t.db.prepare("SELECT COUNT(*) AS n FROM person").first<{ n: number }>();
  const a = await t.db.prepare("SELECT COUNT(*) AS n FROM company_alias").first<{ n: number }>();
  const e = await t.db.prepare("SELECT COUNT(*) AS n FROM event_record").first<{ n: number }>();
  return { companies: c!.n, persons: p!.n, aliases: a!.n, events: e!.n };
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
});

afterAll(async () => {
  await disposeTestDb(t);
});

describe("POST /api/import/dry-run — Network OS person contract", () => {
  it("valid contract payload → report only, zero rows written", async () => {
    const before = await rowCounts();
    const res = await handleRequest(
      req("/api/import/dry-run", "POST", {
        kind: "network_os_person",
        records: [
          { source_system: "network_os", external_key: "nos_1", full_name: "Ada Founder", email: "ada@example.com" },
          { source_system: "network_os", external_key: "nos_2", full_name: "Grace LP" },
        ],
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      dry_run: boolean;
      persisted: boolean;
      findings: Array<{ index: number; outcome: string }>;
    };
    expect(body.dry_run).toBe(true);
    expect(body.persisted).toBe(false);
    expect(body.findings).toHaveLength(2);
    expect(body.findings.every((f) => f.outcome === "would_create")).toBe(true);

    // Zero rows written — including no event spine writes.
    expect(await rowCounts()).toEqual(before);
  });

  it("reports a conflict when the person already exists (by email)", async () => {
    await t.db
      .prepare("INSERT INTO person (id, full_name, email, source) VALUES ('p_import_test', 'Existing Person', 'ada@example.com', 'network_os')")
      .run();
    const res = await handleRequest(
      req("/api/import/dry-run", "POST", {
        kind: "network_os_person",
        records: [{ source_system: "network_os", external_key: "nos_3", full_name: "Ada Again", email: "ADA@example.com" }],
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { findings: Array<{ outcome: string; existing_id?: string }> };
    expect(body.findings[0]!.outcome).toBe("conflict");
    expect(body.findings[0]!.existing_id).toBe("p_import_test");
  });
});

describe("POST /api/import/dry-run — VentureDeals opportunity contract", () => {
  it("resolves to an existing company via external identity and reports conflict; persists nothing", async () => {
    const created = await handleRequest(
      req("/api/companies", "POST", {
        canonical_name: "Import Target Co",
        external_identities: [{ system: "venturedeals", external_key: "vd_company_1" }],
      }),
      env,
    );
    expect(created.status).toBe(201);
    const companyId = ((await created.json()) as { id: string }).id;

    const before = await rowCounts();
    const res = await handleRequest(
      req("/api/import/dry-run", "POST", {
        kind: "venturedeals_opportunity",
        records: [
          {
            source_system: "venturedeals",
            external_key: "vd_opp_1",
            company: {
              canonical_name: "Different Name Entirely",
              external_identities: [{ system: "venturedeals", external_key: "vd_company_1" }],
            },
            opportunity: { name: "Series A", opportunity_type: "EARLY_STAGE" },
          },
          {
            source_system: "venturedeals",
            external_key: "vd_opp_2",
            company: { canonical_name: "Brand New Import Co" },
            opportunity: { name: "Secondary block", opportunity_type: "SECONDARY" },
          },
        ],
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      persisted: boolean;
      findings: Array<{ outcome: string; existing_id?: string }>;
    };
    expect(body.persisted).toBe(false);
    expect(body.findings[0]!.outcome).toBe("conflict");
    expect(body.findings[0]!.existing_id).toBe(companyId);
    expect(body.findings[1]!.outcome).toBe("would_create");
    expect(await rowCounts()).toEqual(before);
  });
});

describe("POST /api/import/dry-run — contract validation", () => {
  it("invalid payloads are 400 and persist nothing", async () => {
    const before = await rowCounts();

    const missingField = await handleRequest(
      req("/api/import/dry-run", "POST", {
        kind: "network_os_person",
        records: [{ source_system: "network_os", external_key: "nos_9" }],
      }),
      env,
    );
    expect(missingField.status).toBe(400);

    const wrongKind = await handleRequest(
      req("/api/import/dry-run", "POST", { kind: "salesforce", records: [] }),
      env,
    );
    expect(wrongKind.status).toBe(400);

    const wrongSource = await handleRequest(
      req("/api/import/dry-run", "POST", {
        kind: "network_os_person",
        records: [{ source_system: "venturedeals", external_key: "x", full_name: "Wrong Source" }],
      }),
      env,
    );
    expect(wrongSource.status).toBe(400);

    const notJson = await handleRequest(
      new Request("https://test.local/api/import/dry-run", {
        method: "POST",
        headers: { ...MP, "content-type": "application/json" },
        body: "not json{",
      }),
      env,
    );
    expect(notJson.status).toBe(400);

    expect(await rowCounts()).toEqual(before);
  });
});
