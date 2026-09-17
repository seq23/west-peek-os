import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { cannotDo, steersWith, unreachable, unreadable } from "./helpers/interpret";
import type { Env } from "../src/worker/env";
import { gatherInstruction, receiptsFor, steerFor, type Interpreter } from "../src/worker/services/instruction";
import {
  buildInterpretationPrompt,
  parseInterpretation,
  steerBlock,
  type InstructionPiece,
} from "../src/shared/work/instruction";
import { runRoomPacketCard } from "../src/worker/services/roomPacket";
import { blockOf } from "../src/worker/services/blocks";
import { sweepIdentity } from "../src/worker/services/workSweep";
import { actorFromIdentity } from "../src/worker/services/authorize";

/**
 * WHAT SHE SAYS REACHES A THINKING MODEL, AND SHE CAN SEE WHAT IT TURNED INTO.
 *
 * The validator (`npm run validate:instructions`) proves that no intake path can exist without
 * calling the interpretation pass. This suite proves the pass BEHAVES: that it gathers every place
 * a human's words can sit on a card, that a chain carries the steer into its prompts, that a chain
 * STOPS on something it cannot honour rather than doing the default, and that the receipt records
 * her words unedited beside what the model made of them.
 *
 * The two are different claims and both are needed. A scan can only prove a function is called.
 */

let t: TestDb;
let env: Env;
const FIRM = "west-peek";
const actor = () => actorFromIdentity({ ...sweepIdentity(), id: "fu_sequoia_taylor" });

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
});
afterAll(async () => {
  await disposeTestDb(t);
});

/** A card an employee owns, with whatever prose the case needs on it. */
async function card(id: string, over: { prompt?: string; blockAnswer?: string } = {}): Promise<void> {
  await env.WP_OS_DB.prepare(
    `INSERT INTO work_card (id, title, description, state, owner_type, owner_id, priority, firm_scope, created_by, prompt)
     VALUES (?1, ?2, 'A card.', 'OPEN', 'AI', 'aie_parker', 'NORMAL', ?3, 'fu_sequoia_taylor', ?4)`,
  )
    .bind(id, `Card ${id}`, FIRM, over.prompt ?? null)
    .run();
  if (over.blockAnswer) {
    await env.WP_OS_DB.prepare("UPDATE work_card SET block_answer = ?2 WHERE id = ?1").bind(id, over.blockAnswer).run();
  }
}

async function note(cardId: string, body: string): Promise<void> {
  await env.WP_OS_DB.prepare("INSERT INTO work_card_note (id, work_card_id, author_id, body) VALUES (?1, ?2, ?3, ?4)")
    .bind(`wcn_${crypto.randomUUID()}`, cardId, "fu_sequoia_taylor", body)
    .run();
}

const req = (cardId: string, kind = "ROOM_PACKET") => ({
  cardId,
  cardKind: kind,
  title: "Build the October Workshop packet",
  employee: "Parker",
  chain: "a monthly Workshop packet",
  steps: ["Research the topic.", "Compare three ways to run it.", "Write the packet.", "Nothing is booked and nobody outside the firm is contacted."],
  firmScope: FIRM,
});

// ── The pure parts ────────────────────────────────────────────────────────────────────────────

describe("reading a model's interpretation back", () => {
  it("reads the three parts, in any order, with or without bullets", () => {
    const out = parseInterpretation(
      "- STEER: 2. compare only virtual formats\nUNDERSTOOD: a workshops packet in the same shape as the rooms ones\n* CANNOT: book the venue",
    );
    expect(out).toEqual({
      understood: "a workshops packet in the same shape as the rooms ones",
      steer: ["2. compare only virtual formats"],
      cannot: ["book the venue"],
    });
  });

  it("treats 'none' as nothing rather than as a directive", () => {
    const out = parseInterpretation("UNDERSTOOD: carry on as usual\nSTEER: none\nCANNOT: N/A");
    expect(out!.steer).toEqual([]);
    expect(out!.cannot).toEqual([]);
  });

  it("RETURNS NULL rather than guessing when the shape is not there", () => {
    // The caller must block on this. An empty steer and a failed interpretation look identical to
    // a chain that carries on, which is the defect this whole pass exists to remove.
    expect(parseInterpretation("Sure! I'd be happy to help with that.")).toBeNull();
    expect(parseInterpretation("STEER: do it differently")).toBeNull();
    expect(parseInterpretation("")).toBeNull();
    expect(parseInterpretation(null)).toBeNull();
  });

  it("puts the steer ABOVE whatever the chain was going to say, and says so", () => {
    const block = steerBlock({ understood: "workshops, in the rooms shape", steer: ["1. search workshops, not rooms"], cannot: [] });
    expect(block).toContain("outranks anything below it");
    expect(block).toContain("workshops, in the rooms shape");
    expect(block).toContain("1. search workshops, not rooms");
    expect(steerBlock(null)).toBe("");
    expect(steerBlock({ understood: "x", steer: [], cannot: [] })).toBe("");
  });

  it("shows the model the steps the work actually has, so it can tell a steer from something impossible", () => {
    const prompt = buildInterpretationPrompt({
      ...req("wc_x"),
      pieces: [{ source: "PROMPT", text: "a packet on workshops, much like he does for rooms" }],
    });
    expect(prompt).toContain("THE STEPS THIS WORK HAS, and it has no others");
    expect(prompt).toContain("1. Research the topic.");
    expect(prompt).toContain("a packet on workshops, much like he does for rooms");
    expect(prompt).toContain("How you said you wanted it done");
    // The rule that makes a CANNOT possible at all.
    expect(prompt).toContain("Do not quietly downgrade something you cannot do into something you can");
  });
});

// ── Gathering ─────────────────────────────────────────────────────────────────────────────────

describe("everywhere a human's words can sit on a card", () => {
  it("gathers the prompt, every unanswered note and the block answer, with the latest last", async () => {
    await card("wc_gather", { prompt: "much like he does for rooms", blockAnswer: "yes, virtual is fine" });
    await note("wc_gather", "make it about pricing");
    await note("wc_gather", "and keep it to ninety minutes");
    const { pieces, noteIds } = await gatherInstruction(env, "wc_gather");
    expect(pieces.map((p) => p.source)).toEqual(["PROMPT", "NOTE", "NOTE", "BLOCK_ANSWER"]);
    expect(pieces.map((p) => p.text)).toEqual([
      "much like he does for rooms",
      "make it about pricing",
      "and keep it to ninety minutes",
      "yes, virtual is fine",
    ]);
    expect(noteIds).toHaveLength(2);
  });

  it("finds nothing on a card nobody has typed on, so a scheduled duty costs no model call", async () => {
    await card("wc_silent");
    let called = 0;
    const counting: Interpreter = async (...args) => { called += 1; return unreadable(...args); };
    const steer = await steerFor(env, actor(), req("wc_silent"), counting);
    expect(called, "a card with no human words must not reach a model at all").toBe(0);
    expect(steer).toEqual({ text: "", interpretation: null, cannot: [], failure: null, aiRunId: null });
  });
});

// ── The pass ──────────────────────────────────────────────────────────────────────────────────

describe("her words reach a model, and what comes back is acted on", () => {
  it("interprets, returns a steer the chain can carry, and answers the note in the model's own words", async () => {
    await card("wc_steer", { prompt: "a packet on workshops, much like he does for rooms" });
    await note("wc_steer", "keep it virtual");
    const steer = await steerFor(
      env,
      actor(),
      req("wc_steer"),
      steersWith("a workshops packet in the same shape as the rooms ones, virtual", "1. research workshops, not rooms", "2. compare virtual formats only"),
    );
    expect(steer.cannot).toEqual([]);
    expect(steer.text).toContain("research workshops, not rooms");
    expect(steer.interpretation!.steer).toHaveLength(2);

    // 0134's CHECK refuses a note marked seen with no response. The response is what it changed.
    const n = await env.WP_OS_DB.prepare("SELECT acknowledged_at, response FROM work_card_note WHERE work_card_id = ?1").bind("wc_steer").first<{ acknowledged_at: string | null; response: string | null }>();
    expect(n!.acknowledged_at).not.toBeNull();
    expect(n!.response).toContain("workshops packet");
  });

  it("does not spend a second call on words it has already read", async () => {
    let calls = 0;
    const counting: Interpreter = async (...args) => { calls += 1; return steersWith("the same thing", "1. do it")(...args); };
    await card("wc_cache", { prompt: "the same instruction" });
    await steerFor(env, actor(), req("wc_cache"), counting);
    await steerFor(env, actor(), req("wc_cache"), counting);
    expect(calls, "the same prose must not be re-interpreted at every stage of a chain").toBe(1);
  });

  it("DOES read again the moment she says something new", async () => {
    let calls = 0;
    const counting: Interpreter = async (...args) => { calls += 1; return steersWith("understood", "1. do it")(...args); };
    await card("wc_fresh", { prompt: "the first instruction" });
    await steerFor(env, actor(), req("wc_fresh"), counting);
    await note("wc_fresh", "actually, make it about secondaries");
    await steerFor(env, actor(), req("wc_fresh"), counting);
    expect(calls, "a note left while the work runs must land on the next stage, not after the card closes").toBe(2);
  });

  it("reports a CANNOT rather than turning it into something it can do", async () => {
    await card("wc_cannot", { prompt: "and book the venue for the 14th" });
    const steer = await steerFor(env, actor(), req("wc_cannot"), cannotDo("a packet, plus booking the venue", "book the venue"));
    expect(steer.cannot).toEqual(["book the venue"]);
  });

  it("treats a model that could not be reached as a stop, never as 'no steer'", async () => {
    await card("wc_down", { prompt: "do it differently this time" });
    const steer = await steerFor(env, actor(), req("wc_down"), unreachable);
    expect(steer.interpretation).toBeNull();
    expect(steer.failure).toContain("no model could be reached");
    expect(steer.cannot.length, "a failure to interpret must stop the work, not pass as silence").toBeGreaterThan(0);
    // The note stays unanswered, so the next attempt picks her words up again.
    const n = await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM work_card_note WHERE work_card_id = ?1 AND acknowledged_at IS NULL").bind("wc_down").first<{ n: number }>();
    expect(n!.n).toBe(0);
  });

  it("treats an unreadable reply the same way", async () => {
    await card("wc_garbled", { prompt: "please do the thing" });
    const steer = await steerFor(env, actor(), req("wc_garbled"), unreadable);
    expect(steer.interpretation).toBeNull();
    expect(steer.failure).toContain("did not say what it understood");
    expect(steer.cannot.length).toBeGreaterThan(0);
  });
});

// ── The chain stops ───────────────────────────────────────────────────────────────────────────

describe("a chain whose input includes prose it cannot honour says so", () => {
  it("BLOCKS Parker's packet with a sentence she can read and buttons she can press, instead of building the default", async () => {
    await env.WP_OS_DB.prepare(
      `INSERT INTO evt_room_packet (id, title, theme, status, proposed_for_month, origin, firm_scope, created_by, build_stage, kind, format, work_card_id)
       VALUES ('rpk_cannot', 'Workshop requested: pricing', 'pricing', 'DRAFT', '2026-10', 'PARTNER_BRIEF', ?1, 'fu_sequoia_taylor', 'QUEUED', 'WORKSHOP', 'WORKSHOP', 'wc_chain')`,
    ).bind(FIRM).run();
    await card("wc_chain", { prompt: "and invite the twenty people on the list" });
    await env.WP_OS_DB.prepare("UPDATE work_card SET kind = 'ROOM_PACKET' WHERE id = ?1").bind("wc_chain").run();

    const out = await runRoomPacketCard(
      env,
      { id: "wc_chain", title: "Build the October Workshop packet", kind: "ROOM_PACKET", owner_id: "aie_parker", state: "OPEN", work_attempts: 1, firm_scope: FIRM },
      {
        interpret: cannotDo("a workshops packet, and the invitations sent", "invite the twenty people on the list"),
        // If any of these runs, the chain built the default despite being told it could not.
        research: async () => { throw new Error("the chain ran a stage it should have stopped before"); },
        synthesise: async () => { throw new Error("the chain ran a stage it should have stopped before"); },
      },
    );
    expect(out.blocked).toBe(true);
    expect(out.finished).toBe(false);

    const row = await env.WP_OS_DB.prepare("SELECT state, block_reason, block_stopped, block_needed, block_who, block_actions_json FROM work_card WHERE id = ?1").bind("wc_chain").first<Record<string, string>>();
    expect(row!.state).toBe("BLOCKED");
    expect(row!.block_reason).toBe("asked_for_something_this_work_cannot_do");
    // Plain language, held to the same standard as every other block: no stage name, no column.
    expect(row!.block_stopped).toBe("Parker can do most of what you asked for here, but not all of it.");
    expect(row!.block_needed).toContain("invite the twenty people on the list");
    const block = blockOf({ state: "BLOCKED", ...row } as never)!;
    expect(block.actions.map((a) => a.key)).toEqual(["ANSWER", "CHANGE", "DROP"]);
  });
});

// ── The receipt ───────────────────────────────────────────────────────────────────────────────

describe("tell me what my instructions turned into", () => {
  it("keeps her words exactly as typed beside what the model made of them, and names the model", async () => {
    await card("wc_receipt", { prompt: "a packet on workshops, much like he does for rooms" });
    await steerFor(env, actor(), req("wc_receipt"), steersWith("a workshops packet in the rooms shape", "1. research workshops"));
    const [receipt] = await receiptsFor(env, "wc_receipt");
    expect(receipt!.said.map((s: InstructionPiece) => s.text)).toEqual(["a packet on workshops, much like he does for rooms"]);
    expect(receipt!.interpretation!.understood).toBe("a workshops packet in the rooms shape");
    expect(receipt!.model).toBe("fake-test-model");
  });

  it("records the failure too, so an interpretation that never happened is visible rather than absent", async () => {
    await card("wc_receipt_fail", { prompt: "do the other thing" });
    await steerFor(env, actor(), req("wc_receipt_fail"), unreachable);
    const [receipt] = await receiptsFor(env, "wc_receipt_fail");
    expect(receipt!.interpretation).toBeNull();
    expect(receipt!.failure).toContain("no model could be reached");
  });

  it("REFUSES to let what she typed be edited afterwards, or deleted", async () => {
    await card("wc_immutable", { prompt: "the words she actually used" });
    await steerFor(env, actor(), req("wc_immutable"), steersWith("understood", "1. do it"));
    const row = await env.WP_OS_DB.prepare("SELECT id FROM work_card_instruction WHERE work_card_id = ?1").bind("wc_immutable").first<{ id: string }>();
    await expect(
      env.WP_OS_DB.prepare("UPDATE work_card_instruction SET said_json = '[]' WHERE id = ?1").bind(row!.id).run(),
    ).rejects.toThrow(/cannot be edited after the fact/);
    await expect(
      env.WP_OS_DB.prepare("DELETE FROM work_card_instruction WHERE id = ?1").bind(row!.id).run(),
    ).rejects.toThrow(/cannot be deleted/);
  });

  it("refuses a receipt that says nothing at all", async () => {
    await expect(
      env.WP_OS_DB.prepare(
        "INSERT INTO work_card_instruction (id, work_card_id, said_json) VALUES ('wci_empty', 'wc_receipt', '[]')",
      ).run(),
    ).rejects.toThrow();
  });
});
