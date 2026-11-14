import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { openAssignmentCard } from "../src/worker/services/dealIntake";
import { EMAILED_TASK_LIMITS } from "../src/shared/intake/partnerAuthority";
import { defaultReadReplyIntent, parseReplyIntent, type ReplyIntentReader } from "../src/worker/services/replyIntent";
import { defaultClassifyActionability } from "../src/worker/services/webPropertyChange";

/**
 * THE ONE PLAIN-WORDS READER (13 Nov 2026). Every partner's words, a new email to os@ or a reply on a
 * thread, are read once for what they mean and which door they go through: answer, route, build.
 */

const calls: Array<{ purpose: string; sensitivity: unknown; budgetContext: Record<string, unknown> | undefined; inputs: string[] }> = [];
let scripted = "";
vi.mock("../src/worker/ai/runAi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/worker/ai/runAi")>();
  return {
    ...actual,
    runAi: async (_env: unknown, input: { purpose: string; sensitivity: unknown; budgetContext?: Record<string, unknown>; inputs: string[] }) => {
      calls.push({ purpose: input.purpose, sensitivity: input.sensitivity, budgetContext: input.budgetContext, inputs: input.inputs });
      return { run: { id: `run_${calls.length}`, status: "COMPLETED", output_text: scripted, failure_reason: null } };
    },
  };
});

let t: TestDb;
let env: Env;
const SCOOTER = "scooter@westpeek.ventures";

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
  await env.WP_OS_DB.prepare("UPDATE ai_employee SET status = 'ACTIVE' WHERE id IN ('aie_porter', 'aie_walker', 'aie_wren', 'aie_wyatt')").run();
});
afterAll(async () => disposeTestDb(t));

const read = (door: string, seat = "none", intent = "CONTINUE", buildIn = "none"): ReplyIntentReader => async (_env, input) => ({ ...parseReplyIntent(`INTENT: ${intent}\nDOOR: ${door}\nSEAT: ${seat}\nBUILD_IN: ${buildIn}\nCHANGES: none\nQUESTION: none\nREASON: test`, input.text), keyword: null, aiRunId: null });

async function cardsFrom(chiefCardId: string) {
  return (await env.WP_OS_DB.prepare("SELECT id, owner_id, state, requested_by_email FROM work_card WHERE id = ?1 OR assigned_from_card_id = ?1").bind(chiefCardId).all<{ id: string; owner_id: string; state: string; requested_by_email: string | null }>()).results ?? [];
}

describe("the reader never reaches a free or training route", () => {
  it("every partner's words are read at INTERNAL, never marked safe for a public model", async () => {
    calls.length = 0;
    scripted = "INTENT: CONTINUE\nDOOR: ANSWER\nSEAT: none\nCHANGES: none\nQUESTION: none\nREASON: x";
    await defaultReadReplyIntent(env, { cardId: "wc_x", firmScope: "west-peek", text: "What did the LP from Tuesday commit?" });
    await defaultClassifyActionability(env, { cardId: "wc_y", firmScope: "west-peek", text: "Can you build me a dashboard?" });
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.sensitivity).toBe("INTERNAL");
      expect(c.budgetContext?.publicModelApproved).not.toBe(true);
      // The partner's words are fenced as data inside the one prompt.
      expect(c.inputs.join("\n")).toMatch(/"""\n[\s\S]+\n"""/);
    }
  });
});

describe("a new email goes to the desk its words name", () => {
  it("work for a named employee is handed straight to them: one card, the chief's closed, the asker kept", async () => {
    const chief = await openAssignmentCard(env, { subject: "Find me fintech seed deals", partnerAddress: SCOOTER, chiefOfStaff: "Walker", raw: "Can you pull together five fintech seed companies in the Southeast worth a look?", limits: EMAILED_TASK_LIMITS, emlKey: null, readWords: read("ROUTE", "Wyatt") });
    const cards = await cardsFrom(chief);
    expect(cards).toHaveLength(2);
    const mine = cards.find((c) => c.id === chief)!;
    const handed = cards.find((c) => c.id !== chief)!;
    expect(mine.state).toBe("DONE");
    expect(handed.owner_id).toBe("aie_wyatt");
    expect(handed.requested_by_email).toBe(SCOOTER);
    const logged = await env.WP_OS_DB.prepare("SELECT payload_json FROM event_record WHERE event_type = 'inbound_email.read' AND object_id = ?1").bind(chief).first<{ payload_json: string }>();
    expect(JSON.parse(logged!.payload_json)).toMatchObject({ door: "ROUTE", seat: "Wyatt", source: "MODEL" });
  });

  it("a question, an unknown seat, or a reader that cannot run leaves it with the chief of staff, unchanged", async () => {
    for (const [subject, reader] of [
      ["What is on for Thursday", read("ANSWER")],
      ["Ask Bob", read("ROUTE", "Bob")],
      ["Hand it to my chief", read("ROUTE", "Walker")],
      ["Reader down", (async (_e, input) => ({ ...parseReplyIntent("", input.text), keyword: null, aiRunId: null })) as ReplyIntentReader],
    ] as const) {
      const chief = await openAssignmentCard(env, { subject, partnerAddress: SCOOTER, chiefOfStaff: "Walker", raw: `${subject}, please.`, limits: EMAILED_TASK_LIMITS, emlKey: null, readWords: reader });
      const cards = await cardsFrom(chief);
      expect(cards, subject).toHaveLength(1);
      expect(cards[0]!.owner_id, subject).toBe("aie_walker");
      expect(cards[0]!.state, subject).not.toBe("DONE");
    }
  });
});

describe("one reading, every door", () => {
  it("banter, a plain question and real work read the same way at the intake classifier", async () => {
    scripted = "INTENT: NOTHING\nDOOR: ANSWER\nSEAT: none\nCHANGES: none\nQUESTION: none\nREASON: thanks";
    expect((await defaultClassifyActionability(env, { cardId: "a", firmScope: "west-peek", text: "lol thanks" })).verdict).toBe("BANTER_NO_ACTION");
    scripted = "INTENT: QUESTION\nDOOR: ANSWER\nSEAT: none\nCHANGES: none\nQUESTION: what are you asking of me?\nREASON: asks";
    expect((await defaultClassifyActionability(env, { cardId: "b", firmScope: "west-peek", text: "what are you asking of me?" })).verdict).toBe("QUESTION_NEEDS_REPLY");
    scripted = "INTENT: CONTINUE\nDOOR: BUILD\nSEAT: none\nCHANGES: none\nQUESTION: none\nREASON: a build";
    expect((await defaultClassifyActionability(env, { cardId: "c", firmScope: "west-peek", text: "build a sign-up page" })).verdict).toBe("ACTIONABLE_WORK");
    scripted = "garbled";
    expect((await defaultClassifyActionability(env, { cardId: "d", firmScope: "west-peek", text: "hmm" })).verdict, "unreadable is real work, never guessed away").toBe("ACTIONABLE_WORK");
  });
});

describe("a question on a job's thread is answered with where the job stands", () => {
  it("a job with no link or build on record still says where it is, never 'it was a question, not a job'", async () => {
    const { jobPhaseLine } = await import("../src/worker/services/webPropertyChange");
    const plan = { phase: "PLAN", check_state: null, land_approved_at: null, plan_approved_at: null } as never;
    expect(jobPhaseLine(plan)).toMatch(/plan is being worked out/);
    expect(jobPhaseLine({ ...(plan as object), phase: "BUILD", plan_approved_at: "2026-11-13T00:00:00Z" } as never)).toMatch(/being built/);
    expect(jobPhaseLine({ ...(plan as object), phase: "BUILD", check_state: "GREEN", plan_approved_at: "x" } as never)).toMatch(/waits on your word on the preview/);
  });
});

describe("one build door: every build ask is Porter's job", () => {
  async function porterJobFrom(chief: string) {
    const handed = (await cardsFrom(chief)).find((c) => c.id !== chief);
    if (!handed) return null;
    const job = await env.WP_OS_DB.prepare("SELECT c.kind, c.owner_id, w.target_repo, w.property_host FROM work_card c JOIN web_property_change w ON w.work_card_id = c.id WHERE c.id = ?1").bind(handed.id).first<{ kind: string; owner_id: string; target_repo: string; property_host: string | null }>();
    return job;
  }

  it("a dashboard inside the OS goes to Porter's job in West Peek OS's own repo", async () => {
    const chief = await openAssignmentCard(env, { subject: "Dashboard for the agents", partnerAddress: SCOOTER, chiefOfStaff: "Walker", raw: "Can you build me a dashboard of what the agents did this week, with the drafts waiting on me?", limits: EMAILED_TASK_LIMITS, emlKey: null, readWords: read("BUILD", "none", "CONTINUE", "OS") });
    const job = await porterJobFrom(chief);
    expect(job).toMatchObject({ kind: "WEB_PROPERTY_CHANGE", owner_id: "aie_porter", target_repo: "west-peek-os", property_host: "os.joinwestpeek.com" });
  });

  it("an app with no site named goes to Porter's job unresolved, never assumed to be the last site he worked on", async () => {
    const chief = await openAssignmentCard(env, { subject: "An app for the Rooms", partnerAddress: SCOOTER, chiefOfStaff: "Walker", raw: "Make me a simple app where Room hosts can check people in.", limits: EMAILED_TASK_LIMITS, emlKey: null, readWords: read("BUILD", "none", "CONTINUE", "NEW") });
    const job = await porterJobFrom(chief);
    expect(job).toMatchObject({ kind: "WEB_PROPERTY_CHANGE", owner_id: "aie_porter", target_repo: "unresolved", property_host: null });
  });

  it("a dashboard card typed in the OS is a build for Porter, never a panel report", async () => {
    const { createWorkCardInternal } = await import("../src/worker/services/workCards");
    const { runArtifactCard } = await import("../src/worker/services/artifacts");
    const { systemIdentity } = await import("../src/worker/services/dealIntake");
    const made = await createWorkCardInternal(env, systemIdentity(), { title: "Wren, build me a dashboard of open cards by employee", owner_type: "AI", owner_id: "aie_wren", firm_scope: "west-peek", priority: "NORMAL" } as never);
    expect((await env.WP_OS_DB.prepare("SELECT kind FROM work_card WHERE id = ?1").bind(made.id).first<{ kind: string }>())!.kind).toBe("ARTIFACT");
    const out = await runArtifactCard(env, { id: made.id });
    expect(out.finished, out.detail).toBe(true);
    const job = await porterJobFrom(made.id);
    expect(job).toMatchObject({ kind: "WEB_PROPERTY_CHANGE", owner_id: "aie_porter", target_repo: "west-peek-os" });
    expect((await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM artifact WHERE work_card_id = ?1").bind(made.id).first<{ n: number }>())!.n).toBe(0);
  });
});
