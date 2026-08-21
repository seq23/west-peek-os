import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { handleRequest } from "../src/worker/index";
import type { Env } from "../src/worker/env";
import { buildTranslationPrompt, writtenGuidance } from "../src/worker/services/firmSkills";

/**
 * The firm writing down its own methods.
 *
 * The operator wanted to write in plain English how they want something done and have it become an
 * instruction their employees follow. Two things decide whether that is real:
 *
 *   1. An ADOPTED method reaches a prompt. A method shown on a page and never read by an employee
 *      is decoration, and this repository already has fifteen backend routes nothing calls.
 *   2. A DRAFT does not. A sentence typed into a box must not become a live instruction that nobody
 *      read in its final form.
 */

let t: TestDb;
let env: Env;

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
});

afterAll(async () => {
  await disposeTestDb(t);
});

async function insertSkill(id: string, status: "DRAFT" | "ADOPTED", title: string): Promise<void> {
  await t.db
    .prepare(
      `INSERT INTO firm_skill (id, machine_key, title, when_to_use, guidance_json, source_text, status, created_by, firm_scope)
       VALUES (?1, 'research_intelligence', ?2, 'When screening a company nobody has heard of', ?3, 'plain english the partner typed', ?4, 'fu_scooter_taylor', 'west-peek')`,
    )
    .bind(id, title, JSON.stringify(["Name the customer before the technology.", "Say who you could not reach."]), status)
    .run();
}

describe("an adopted method reaches the employees who follow it", () => {
  it("puts an adopted method into the guidance an employee reads", async () => {
    await insertSkill("fsk_adopted", "ADOPTED", "Screening an unknown company");
    const block = await writtenGuidance(env, ["research_intelligence"]);
    expect(block).toContain("Screening an unknown company");
    expect(block).toContain("Name the customer before the technology.");
    // It must say whose method it is: a partner's decision outranks the general library above it.
    expect(block).toContain("METHODS THE PARTNERS WROTE");
  });

  it("does NOT put a draft into the guidance, because nobody has read it in its final form yet", async () => {
    await insertSkill("fsk_draft", "DRAFT", "Something nobody approved");
    const block = await writtenGuidance(env, ["research_intelligence"]);
    expect(block).not.toContain("Something nobody approved");
  });

  it("says nothing at all for a machine with no written methods", async () => {
    // An employee told "METHODS THE PARTNERS WROTE:" followed by nothing has been told something
    // false about the firm — the same rule guidanceBlock already holds.
    expect(await writtenGuidance(env, ["finance_fund_admin"])).toBe("");
    expect(await writtenGuidance(env, [])).toBe("");
  });
});

describe("the two sources are never merged silently", () => {
  it("marks which methods were reviewed in the repository and which the firm wrote here", async () => {
    const res = await handleRequest(new Request("https://test.local/api/firm-skills", { headers: MP }), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      machines: Array<{ machine_key: string; reviewed: unknown[]; written: Array<{ origin: string; status: string }> }>;
      notes: Record<string, string>;
    };

    const research = body.machines.find((m) => m.machine_key === "research_intelligence")!;
    expect(research.reviewed.length).toBeGreaterThan(0);
    expect(research.written.every((w) => w.origin === "WRITTEN")).toBe(true);
    // The reader is told where each kind lives, and where to go to read the reviewed ones in full.
    expect(body.notes.source).toContain("library.ts");
    expect(body.notes.origins).toContain("pull request");
  });

  it("hides a retired method from the page without deleting what was written", async () => {
    await insertSkill("fsk_retired", "ADOPTED", "A method we stopped using");
    await t.db.prepare("UPDATE firm_skill SET status = 'RETIRED' WHERE id = 'fsk_retired'").run();

    const res = await handleRequest(new Request("https://test.local/api/firm-skills", { headers: MP }), env);
    const body = (await res.json()) as { machines: Array<{ written: Array<{ title: string }> }> };
    const titles = body.machines.flatMap((m) => m.written.map((w) => w.title));
    expect(titles).not.toContain("A method we stopped using");

    const row = await t.db.prepare("SELECT source_text FROM firm_skill WHERE id = 'fsk_retired'").first<{ source_text: string }>();
    expect(row?.source_text).toBe("plain english the partner typed");
  });
});

describe("the translation is a rendering, not an opinion", () => {
  it("tells the model to say only what the partner said", () => {
    const prompt = buildTranslationPrompt("Research & Intelligence Machine", "Always check who the customer is.");
    expect(prompt).toContain("Always check who the customer is.");
    expect(prompt).toContain("Say only what they said");
    // The important instruction: an invented rule becomes something every employee follows.
    expect(prompt).toContain("If what they wrote is vague, keep it vague");
    expect(prompt).toContain("Research & Intelligence Machine");
  });
});

describe("adopting is a decision, and refusing says why", () => {
  it("refuses to adopt for someone who is not a Managing Partner, in words they can act on", async () => {
    await insertSkill("fsk_forbidden", "DRAFT", "Needs a partner");
    const res = await handleRequest(
      new Request("https://test.local/api/firm-skills/fsk_forbidden/adopt", {
        method: "POST",
        headers: { "x-wpos-dev-user": "browser-agent@westpeek.ventures" },
      }),
      env,
    );
    expect([401, 403]).toContain(res.status);
  });

  it("will not adopt the same method twice", async () => {
    const res = await handleRequest(
      new Request("https://test.local/api/firm-skills/fsk_adopted/adopt", { method: "POST", headers: MP }),
      env,
    );
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "already_adopted" });
  });

  it("refuses a machine key that is not in the registry rather than writing an orphan", async () => {
    const res = await handleRequest(
      new Request("https://test.local/api/firm-skills/draft", {
        method: "POST",
        headers: { ...MP, "content-type": "application/json" },
        body: JSON.stringify({ machine_key: "not_a_machine", plain_english: "Do the thing carefully every time." }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "unknown_machine" });
  });
});
