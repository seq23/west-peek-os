import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import type { Actor } from "../src/worker/services/authorize";
import { reply, startSession, type Teach } from "../src/worker/services/university";
import { LEARNING_MODES, professorPrompt, trimHistory } from "../src/shared/university/professor";

/**
 * West Peek University (P45) — the eight behaviours the brief calls the definition of done.
 *
 * The teaching STANCE is tested as hard as the plumbing: "never praise a wrong answer" is the
 * product decision that separates this from a chatbot, and a well-meaning edit that softens it
 * should fail here.
 */

let t: TestDb;
let env: Env;
const SEQ: Actor = { type: "HUMAN", firmUserId: "fu_sequoia_taylor", roles: ["MANAGING_PARTNER"], firmScopes: ["west-peek"] };
const SCOOT: Actor = { type: "HUMAN", firmUserId: "fu_scooter_taylor", roles: ["MANAGING_PARTNER"], firmScopes: ["west-peek"] };

/** Echoes the prompt back so tests can assert what the professor was actually told. */
let lastSystem = "";
const fakeProfessor: Teach = async (_e, _a, system, exchange) => {
  lastSystem = system;
  return { text: `TAUGHT[${exchange.slice(0, 40)}]`, aiRunId: null };
};
const brokenProfessor: Teach = async () => ({ text: "", aiRunId: null, failure: "provider timeout" });

beforeAll(async () => { t = await createTestDb(); env = makeTestEnv(t.db); });
afterAll(async () => { await disposeTestDb(t); });

describe("the teaching stance", () => {
  it("refuses to praise a wrong answer", () => {
    const p = professorPrompt("pro rata", "LEARN");
    expect(p).toMatch(/[Nn]ever praise an answer that is materially incorrect/);
    expect(p).toMatch(/Right conclusion, wrong reason/);
  });

  it("will not invent facts about real companies", () => {
    // The rule that keeps a teaching tool from becoming a source of confident fiction.
    expect(professorPrompt("x", "LEARN")).toMatch(/Do not invent facts about real companies/);
  });

  it("points at Research for anything current", () => {
    expect(professorPrompt("x", "LEARN")).toMatch(/point them\s+at Research/);
  });

  it("offers all six modes", () => {
    expect(LEARNING_MODES).toHaveLength(6);
  });

  it("changes the instruction per mode", () => {
    expect(professorPrompt("pro rata", "TEST_ME")).toMatch(/Ask ONE question/);
    expect(professorPrompt("pro rata", "ONE_PAGER")).toMatch(/No questions in this mode/);
    expect(professorPrompt("pro rata", "TEACH_BACK")).toMatch(/in their own words/);
  });

  it("carries the topic into the prompt", () => {
    expect(professorPrompt("liquidation preferences", "LEARN")).toMatch(/TOPIC: liquidation preferences/);
  });
});

describe("history", () => {
  const turns = Array.from({ length: 30 }, (_, n) => ({ role: n % 2 ? "LEARNER" : "INSTRUCTOR", body: `t${n}` }));

  it("trims a long conversation", () => {
    expect(trimHistory(turns, 10)).toHaveLength(10);
  });

  it("always keeps the opening instructor turn", () => {
    // That turn framed the lesson; dropping it makes the professor lose what it already covered.
    expect(trimHistory(turns, 10).map((x) => x.body)).toContain("t0");
  });

  it("leaves a short conversation alone", () => {
    expect(trimHistory(turns.slice(0, 4), 10)).toHaveLength(4);
  });
});

describe("sessions", () => {
  let sessionId = "";

  it("starts on any topic, with no lesson catalogue involved", async () => {
    const out = await startSession(env, SEQ, { topic: "continuation vehicles in secondaries", mode: "LEARN" }, fakeProfessor);
    sessionId = out.session.id;
    expect(out.session.topic).toBe("continuation vehicles in secondaries");
    expect(out.turns).toHaveLength(1);
    expect(out.turns[0]!.role).toBe("INSTRUCTOR");
  });

  it("opens rather than lecturing", async () => {
    expect(lastSystem).toMatch(/TOPIC: continuation vehicles/);
  });

  it("keeps context on a follow-up", async () => {
    const out = await reply(env, SEQ, sessionId, "Is that the same as a strip sale?", fakeProfessor);
    expect(out.turns).toHaveLength(3);
    expect(out.turns[1]!.role).toBe("LEARNER");
    expect(out.turns[2]!.body).toMatch(/TAUGHT/);
  });

  it("survives a reload — history is persisted, not in the page", async () => {
    const rows = await env.WP_OS_DB.prepare(
      "SELECT COUNT(*) n FROM university_turn WHERE session_id = ?1",
    ).bind(sessionId).first<{ n: number }>();
    expect(rows!.n).toBe(3);
  });

  it("refuses an empty topic", async () => {
    await expect(startSession(env, SEQ, { topic: " ", mode: "LEARN" }, fakeProfessor))
      .rejects.toMatchObject({ code: "topic_required" });
  });
});

describe("a failed provider call", () => {
  it("records a visible failure and keeps the session", async () => {
    const out = await startSession(env, SEQ, { topic: "cap table mechanics", mode: "LEARN" }, brokenProfessor);
    expect(out.session.id).toBeTruthy();
    expect(out.turns[0]!.state).toBe("FAILED");
    expect(out.turns[0]!.body).toMatch(/session is still saved/);
  });

  it("does not leak the provider error into the learner's message", async () => {
    const out = await startSession(env, SEQ, { topic: "reserves strategy", mode: "LEARN" }, brokenProfessor);
    expect(out.turns[0]!.body).not.toMatch(/timeout/);
    // The cause is kept for whoever has to fix it, just not shown as the lesson.
    expect(out.turns[0]!.detail).toMatch(/timeout/);
  });

  it("lets the learner continue after a failure", async () => {
    const started = await startSession(env, SEQ, { topic: "dilution", mode: "LEARN" }, brokenProfessor);
    const out = await reply(env, SEQ, started.session.id, "try again please", fakeProfessor);
    expect(out.turns.some((x) => x.role === "INSTRUCTOR" && x.state === "OK")).toBe(true);
  });
});

describe("privacy", () => {
  it("hides one learner's session from another", async () => {
    // Studying what you do not yet understand is private. Scooter must not be able to read
    // Sequoia's sessions, and a 404 rather than a 403 avoids confirming the session exists.
    const mine = await startSession(env, SEQ, { topic: "private topic", mode: "LEARN" }, fakeProfessor);
    await expect(reply(env, SCOOT, mine.session.id, "peek", fakeProfessor))
      .rejects.toMatchObject({ status: 404 });
  });
});
