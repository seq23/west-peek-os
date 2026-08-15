import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { handleRequest } from "../src/worker/index";
import type { Env } from "../src/worker/env";
import { enhanceIntent } from "../src/worker/services/workPackets";
import { BLOCKING_LENSES, DEFAULT_LENS_STACK } from "../src/shared/registry/lenses";

/**
 * P18 — Intent-to-execution work packets + the Institutional Lens Bench (GAP-08, GAP-09).
 *
 * Rules under test:
 * - Enhancement is deterministic (same input, same output) and NEVER replaces the operator's
 *   words: `original_text` is immutable at the database layer.
 * - Enhancement strength changes depth without hiding the original.
 * - Reserved-authority topics in the text surface as risks and as an acceptance criterion that
 *   the output prepares rather than makes the decision.
 * - Routing recommendations come from real records and return null rather than guessing; a
 *   PAUSED machine is never recommended.
 * - Lens findings persist verdict/critique/evidence/summary and nothing else — the table has no
 *   chain-of-thought column, asserted against the live schema.
 * - The Truth/Compliance Gate BLOCKS: ADVERSE moves the packet to BLOCKED_BY_LENS and execution
 *   is refused; a blocking lens that never ran also refuses execution (silence is not a pass).
 * - Execution opens a real work card and a governed AI run, and records both on the packet.
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

async function newPacket(text: string, over: Record<string, unknown> = {}): Promise<any> {
  const res = await call<{ packet: any }>("/api/work-packets", MP, "POST", { text, ...over });
  expect(res.status).toBe(201);
  return res.body.packet;
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
});

afterAll(async () => {
  await disposeTestDb(t);
});

describe("enhancement is deterministic and never speaks over the operator", () => {
  it("produces identical output for identical input", () => {
    const a = enhanceIntent("Look into the Acme secondary soon", "STANDARD");
    const b = enhanceIntent("Look into the Acme secondary soon", "STANDARD");
    expect(a).toEqual(b);
  });

  it("names vagueness, a missing deadline, and a missing deliverable", () => {
    const r = enhanceIntent("Look into the Acme secondary soon", "STANDARD");
    expect(r.ambiguities.join(" ")).toContain("soon");
    expect(r.ambiguities.join(" ")).toContain("No deadline");
    expect(r.ambiguities.join(" ")).toContain("deliverable is not named");
    expect(r.assumptions.length).toBeGreaterThan(0);
  });

  it("surfaces reserved-authority risk and adds the prepare-not-decide criterion", () => {
    const r = enhanceIntent("Draft the LP update and confirm the valuation before the wire", "STANDARD");
    expect(r.risks.join(" ")).toContain("LP-facing");
    expect(r.risks.join(" ")).toContain("Capital movement is human-reserved");
    expect(r.acceptance_criteria).toContain("The output prepares a decision; it does not make one.");
  });

  it("DEEP adds hostile-review criteria; NONE derives nothing at all", () => {
    const deep = enhanceIntent("Write a memo on the market", "DEEP");
    expect(deep.acceptance_criteria.join(" ")).toContain("counter-case");
    const none = enhanceIntent("Write a memo on the market", "NONE");
    expect(none.interpretation).toBe("");
    expect(none.acceptance_criteria).toEqual([]);
  });

  it("stores the original text verbatim and refuses to let anything overwrite it", async () => {
    const original = "Look into the Acme secondary soon";
    const packet = await newPacket(original);
    expect(packet.original_text).toBe(original);
    expect(packet.enhancement_origin).toBe("DETERMINISTIC");
    expect(packet.interpretation).toContain("original wording is preserved verbatim");

    await expect(
      t.db.prepare("UPDATE work_packet SET original_text = 'rewritten by the machine' WHERE id = ?1").bind(packet.id).run(),
    ).rejects.toThrow(/immutable/);
  });

  it("opens with the default lens stack and records a first revision", async () => {
    const packet = await newPacket("Summarise this week's portfolio alerts");
    expect(JSON.parse(packet.lens_stack_json)).toEqual([...DEFAULT_LENS_STACK]);
    const detail = await call<{ revisions: any[] }>(`/api/work-packets/${packet.id}`, MP);
    expect(detail.body.revisions).toHaveLength(1);
    expect(detail.body.revisions[0]!.note).toBe("packet created");
  });
});

describe("routing recommendations come from real records", () => {
  it("recommends a machine whose own declared purpose overlaps the intent, and explains why", async () => {
    const packet = await newPacket("Prepare research intelligence on secondaries pricing");
    expect(packet.machine_id).not.toBeNull();
    expect(packet.cost_basis).toContain("matched");
  });

  it("recommends nothing rather than guessing when nothing overlaps", async () => {
    const packet = await newPacket("zzzz");
    expect(packet.machine_id).toBeNull();
    expect(packet.cost_basis).toContain("left to the operator");
  });

  it("never recommends a PAUSED machine", async () => {
    // Pause the research machine, then ask for research work.
    const paused = await call("/api/machines/23/pause", MP, "POST", { status: "PAUSED", reason: "under review" });
    expect(paused.status).toBe(200);

    const packet = await newPacket("Prepare research intelligence on secondaries pricing");
    expect(packet.machine_id).toBeNull();
    expect(packet.cost_basis).toContain("PAUSED");

    await call("/api/machines/23/pause", MP, "POST", { status: "ACTIVE", reason: "review finished" });
  });
});

describe("the lens bench stores products, never reasoning", () => {
  it("publishes the bench with its storage rule", async () => {
    const res = await call<{ lenses: any[]; blocking: string[]; storage_rule: string }>("/api/work-packets/lens-bench", MP);
    expect(res.status).toBe(200);
    expect(res.body.lenses).toHaveLength(6);
    expect(res.body.blocking).toEqual([...BLOCKING_LENSES]);
    expect(res.body.storage_rule).toContain("Private model reasoning is never stored");
  });

  it("has no column a chain-of-thought could be written to", async () => {
    const cols = await t.db.prepare("PRAGMA table_info(lens_output)").all<{ name: string }>();
    const names = (cols.results ?? []).map((c) => c.name);
    expect(names).toContain("critique");
    expect(names).toContain("verdict");
    expect(names).toContain("evidence_refs_json");
    for (const banned of ["reasoning", "chain_of_thought", "thoughts", "scratchpad", "trace", "deliberation"]) {
      expect(names).not.toContain(banned);
    }
  });

  it("refuses a lens that is not in the packet's stack, and refuses to re-run one", async () => {
    const packet = await newPacket("Write a memo on the fund's reserve position");
    const notInStack = await call(`/api/work-packets/${packet.id}/lenses`, MP, "POST", {
      lens_key: "HOSTILE_REVIEWER",
      verdict: "PASS",
      critique: "not selected for this packet",
    });
    expect(notInStack.status).toBe(409);
    expect((notInStack.body as any).error).toBe("lens_not_in_stack");

    const first = await call(`/api/work-packets/${packet.id}/lenses`, MP, "POST", {
      lens_key: "LEAD",
      verdict: "PASS",
      critique: "The ask is clear enough to work.",
    });
    expect(first.status).toBe(201);
    const again = await call(`/api/work-packets/${packet.id}/lenses`, MP, "POST", {
      lens_key: "LEAD",
      verdict: "CONCERN",
      critique: "changed my mind",
    });
    expect(again.status).toBe(409);
    expect((again.body as any).error).toBe("lens_already_run");
  });

  it("keeps lens findings append-only at the database layer", async () => {
    const row = await t.db.prepare("SELECT id FROM lens_output LIMIT 1").first<{ id: string }>();
    await expect(t.db.prepare("UPDATE lens_output SET verdict = 'PASS' WHERE id = ?1").bind(row!.id).run()).rejects.toThrow(/append-only/);
    await expect(t.db.prepare("DELETE FROM lens_output WHERE id = ?1").bind(row!.id).run()).rejects.toThrow(/append-only/);
  });
});

describe("privacy is enforced in SQL, not by the client (final-review repair)", () => {
  it("hides a RESTRICTED packet from a user without the scope, on both list and read", async () => {
    // Seeded firm users are both Managing Partners, so the boundary is exercised against a
    // deliberately scope-less identity created here.
    await t.db
      .prepare("INSERT OR IGNORE INTO firm_user (id, email, full_name, status) VALUES ('fu_scopeless', 'scopeless@westpeek.ventures', 'Scopeless User', 'ACTIVE')")
      .run();
    await t.db
      .prepare("INSERT OR IGNORE INTO firm_user_role (firm_user_id, role_id) VALUES ('fu_scopeless', 'role_investment_team')")
      .run();
    const SCOPELESS = { "x-wpos-dev-user": "scopeless@westpeek.ventures" };

    const restricted = await newPacket("Handle the restricted matter", { privacy_label: "RESTRICTED" });
    expect(restricted.privacy_label).toBe("RESTRICTED");

    const mpList = await call<{ packets: any[] }>("/api/work-packets", MP);
    expect(mpList.body.packets.some((p: any) => p.id === restricted.id)).toBe(true);

    const theirList = await call<{ packets: any[] }>("/api/work-packets", SCOPELESS);
    expect(theirList.body.packets.some((p: any) => p.id === restricted.id)).toBe(false);

    // Reading it directly is not_found rather than forbidden: existence is not disclosed.
    const theirRead = await call(`/api/work-packets/${restricted.id}`, SCOPELESS);
    expect(theirRead.status).toBe(404);
    const mpRead = await call(`/api/work-packets/${restricted.id}`, MP);
    expect(mpRead.status).toBe(200);
  });

  it("a packet they cannot read is a packet they cannot act on", async () => {
    const SCOPELESS = { "x-wpos-dev-user": "scopeless@westpeek.ventures" };
    const restricted = await newPacket("Another restricted matter", { privacy_label: "RESTRICTED" });

    // Every mutation path applies the same visibility rule as the read path.
    const lens = await call(`/api/work-packets/${restricted.id}/lenses`, SCOPELESS, "POST", {
      lens_key: "LEAD",
      verdict: "PASS",
      critique: "should never be recorded",
    });
    expect(lens.status).toBe(404);

    const revise = await call(`/api/work-packets/${restricted.id}`, SCOPELESS, "PATCH", { interpretation: "should not apply" });
    expect(revise.status).toBe(404);

    const execute = await call(`/api/work-packets/${restricted.id}/execute`, SCOPELESS, "POST");
    expect(execute.status).toBe(404);

    // Nothing was written on their behalf.
    const lenses = await t.db.prepare("SELECT COUNT(*) AS n FROM lens_output WHERE packet_id = ?1").bind(restricted.id).first<{ n: number }>();
    expect(lenses!.n).toBe(0);

    // The Managing Partner, who can see it, still can.
    const mpLens = await call(`/api/work-packets/${restricted.id}/lenses`, MP, "POST", {
      lens_key: "LEAD",
      verdict: "PASS",
      critique: "recorded by someone entitled to see the packet",
    });
    expect(mpLens.status).toBe(201);
  });
});

describe("execution is gated by the blocking lens", () => {
  it("refuses to execute while a blocking lens has never run — silence is not a pass", async () => {
    const packet = await newPacket("Write a memo on the market");
    const res = await call(`/api/work-packets/${packet.id}/execute`, MP, "POST");
    expect(res.status).toBe(409);
    expect((res.body as any).error).toBe("blocking_lens_not_run");
    expect((res.body as any).detail).toContain("TRUTH_COMPLIANCE_GATE");
  });

  it("an ADVERSE gate blocks the packet and execution stays refused", async () => {
    const packet = await newPacket("Publish an LP claim about our top-quartile performance");
    const gate = await call<{ packet: { status: string } }>(`/api/work-packets/${packet.id}/lenses`, MP, "POST", {
      lens_key: "TRUTH_COMPLIANCE_GATE",
      verdict: "ADVERSE",
      critique: "A performance claim to LPs needs verified evidence and the reserved marketing-claim approval.",
      summary: "Refused: unsupported LP performance claim.",
    });
    expect(gate.status).toBe(201);
    expect(gate.body.packet.status).toBe("BLOCKED_BY_LENS");

    const exec = await call(`/api/work-packets/${packet.id}/execute`, MP, "POST");
    expect(exec.status).toBe(409);
    expect((exec.body as any).error).toBe("blocked_by_lens");
  });

  it("executes once the gate passes, opening a real work card and a governed run", async () => {
    const packet = await newPacket("Write a memo summarising open portfolio alerts");
    await call(`/api/work-packets/${packet.id}/lenses`, MP, "POST", {
      lens_key: "TRUTH_COMPLIANCE_GATE",
      verdict: "PASS",
      critique: "Internal summary of records we already hold; asserts no external conclusion.",
    });
    await call(`/api/work-packets/${packet.id}/lenses`, MP, "POST", {
      lens_key: "NO_PEDESTAL",
      verdict: "CONCERN",
      critique: "Two of the alerts cite a well-known investor's opinion; that is not evidence.",
    });

    const exec = await call<{ packet: any; work_card: { id: string }; run: { id: string; status: string } }>(
      `/api/work-packets/${packet.id}/execute`,
      MP,
      "POST",
    );
    expect(exec.status).toBe(200);
    expect(exec.body.packet.status).toBe("COMPLETE");
    expect(exec.body.packet.work_card_id).toBe(exec.body.work_card.id);
    expect(exec.body.packet.ai_run_id).toBe(exec.body.run.id);

    // The work card is real governed work, and the run is attributed for cost.
    const card = await t.db.prepare("SELECT state FROM work_card WHERE id = ?1").bind(exec.body.work_card.id).first<{ state: string }>();
    expect(card!.state).toBe("OPEN");
    const attribution = await t.db.prepare("SELECT work_card_id FROM ai_run_attribution WHERE ai_run_id = ?1").bind(exec.body.run.id).first<{ work_card_id: string }>();
    expect(attribution!.work_card_id).toBe(exec.body.work_card.id);

    const second = await call(`/api/work-packets/${packet.id}/execute`, MP, "POST");
    expect(second.status).toBe(409);
  });

  it("refuses to revise a completed packet", async () => {
    const done = await t.db.prepare("SELECT id FROM work_packet WHERE status = 'COMPLETE' LIMIT 1").first<{ id: string }>();
    const res = await call(`/api/work-packets/${done!.id}`, MP, "PATCH", { interpretation: "after the fact" });
    expect(res.status).toBe(409);
  });

  it("revisions accumulate and are append-only", async () => {
    const packet = await newPacket("Draft a list of follow-on candidates");
    await call(`/api/work-packets/${packet.id}`, MP, "PATCH", { output_definition: "A ranked list with reserve impact.", note: "sharpened the deliverable" });
    const detail = await call<{ revisions: any[] }>(`/api/work-packets/${packet.id}`, MP);
    expect(detail.body.revisions).toHaveLength(2);
    await expect(
      t.db.prepare("UPDATE work_packet_revision SET note = 'x' WHERE id = ?1").bind(detail.body.revisions[0]!.id).run(),
    ).rejects.toThrow(/append-only/);
  });
});
