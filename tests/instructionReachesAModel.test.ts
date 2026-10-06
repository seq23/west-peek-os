import { partnerPracticesBlock } from "../src/shared/work/partnerPractices";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { cannotDo, handsOffTo, steersWith, unreachable, unreadable } from "./helpers/interpret";
import type { Env } from "../src/worker/env";
import { gatherInstruction, receiptsFor, steerFor, type Interpreter } from "../src/worker/services/instruction";
import {
  buildInterpretationPrompt,
  parseInterpretation,
  steerBlock,
  type InstructionPiece,
} from "../src/shared/work/instruction";
import { runRoomPacketCard, STAGE_STEPS } from "../src/worker/services/roomPacket";
import { blockOf } from "../src/worker/services/blocks";
import { sweepIdentity } from "../src/worker/services/workSweep";
import { actorFromIdentity } from "../src/worker/services/authorize";
import { HIRE_SEARCH_STEPS } from "../src/worker/services/productionsHire";
import { DECK_REWORK_STEPS } from "../src/worker/services/deck";
import { BLOG_STEPS } from "../src/worker/services/blogHelp";
import { ARTIFACT_CARD_STEPS } from "../src/worker/services/artifacts";
import { PRODUCTIONS_STEPS } from "../src/worker/services/productions";

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
      handoff: [],
    });
  });

  it("reads a HANDOFF line as a kind and a note, and falls back to a CANNOT when the kind will not parse", () => {
    const out = parseInterpretation(
      "UNDERSTOOD: update the pricing page and search for a candidate\nHANDOFF: WEB_PROPERTY_CHANGE — update the pricing page with the new tiers\nHANDOFF: not a real kind, no separator here properly",
    );
    expect(out!.handoff).toEqual([{ kind: "WEB_PROPERTY_CHANGE", note: "update the pricing page with the new tiers" }]);
    // The second HANDOFF had no parseable "<KIND> — note" shape, so it fails closed into a CANNOT
    // rather than being silently dropped or guessed at.
    expect(out!.cannot).toEqual(["not a real kind, no separator here properly"]);
  });

  it("treats 'none' as nothing rather than as a directive", () => {
    const out = parseInterpretation("UNDERSTOOD: carry on as usual\nSTEER: none\nCANNOT: N/A");
    expect(out!.steer).toEqual([]);
    expect(out!.cannot).toEqual([]);
    expect(out!.handoff).toEqual([]);
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
    const block = steerBlock({ understood: "workshops, in the rooms shape", steer: ["1. search workshops, not rooms"], cannot: [], handoff: [] });
    expect(block).toContain("outranks anything below it");
    expect(block).toContain("workshops, in the rooms shape");
    expect(block).toContain("1. search workshops, not rooms");
    expect(steerBlock(null)).toBe("");
    expect(steerBlock({ understood: "x", steer: [], cannot: [], handoff: [] })).toBe("");
  });

  it("mentions a resolved handoff as something NOT to attempt, even with no steer of its own", () => {
    const block = steerBlock({ understood: "the pricing page and a search", steer: [], cannot: [], handoff: [] }, [
      { employee: "Porter", note: "update the pricing page with the new tiers" },
    ]);
    expect(block).toContain("outranks anything below it");
    expect(block).toContain("already handed to Porter");
    expect(block).toContain("Do not attempt this part yourself");
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
    // The standing principle (22 Sep 2026): an ask not on the numbered list is not automatically a
    // CANNOT — it is a STEER when the employee can already do it with judgement and its own tools.
    expect(prompt).toContain("standing authority to widen what");
    expect(prompt).toContain("Do not call something a CANNOT only because it is not one of the numbered steps above");
  });

  it("names another employee's domain and asks for a HANDOFF rather than a CANNOT, only when one is registered", () => {
    const withDomain = buildInterpretationPrompt({
      ...req("wc_y"),
      pieces: [{ source: "PROMPT", text: "also fix the pricing page" }],
      otherDomains: [{ kind: "WEB_PROPERTY_CHANGE", employee: "Porter", because: "every web property change is his to run" }],
    });
    expect(withDomain).toContain("OTHER EMPLOYEES' OWN DOMAINS");
    expect(withDomain).toContain("WEB_PROPERTY_CHANGE: Porter — every web property change is his to run");
    expect(withDomain).toContain("HANDOFF: <KIND>");

    const withoutDomain = buildInterpretationPrompt({ ...req("wc_z"), pieces: [] });
    expect(withoutDomain).not.toContain("OTHER EMPLOYEES' OWN DOMAINS");
    expect(withoutDomain).not.toContain("HANDOFF: <KIND>");
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
    // 0254: nothing a human said, so nothing interpreted — but the standing partner practices ride on every
    // steer, exactly the shared block and nothing else.
    expect(steer).toEqual({ text: partnerPracticesBlock([]), interpretation: null, cannot: [], failure: null, aiRunId: null, handoffs: [] });
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

// ── The third outcome: not this chain's job, but somebody's ─────────────────────────────────────

describe("something that is not this chain's job, but IS a different, real employee's (22 Sep 2026)", () => {
  it("hands it to that employee's own desk instead of blocking or bolting it onto this chain", async () => {
    await card("wc_handoff", { prompt: "also fix the pricing page with the new tiers while you're at it" });
    const steer = await steerFor(
      env,
      actor(),
      req("wc_handoff"),
      handsOffTo(
        "a workshops packet, and separately the pricing page fixed",
        "WEB_PROPERTY_CHANGE",
        "fix the pricing page with the new tiers",
        "1. research workshops as usual",
      ),
    );
    // Not blocked: the ask was real, and it now lives somewhere real.
    expect(steer.cannot).toEqual([]);
    expect(steer.handoffs).toHaveLength(1);
    expect(steer.handoffs[0]).toMatchObject({ kind: "WEB_PROPERTY_CHANGE", resolved: true, employee: "Porter" });
    expect(steer.handoffs[0]!.cardId).toBeTruthy();
    expect(steer.text).toContain("already handed to Porter");
    expect(steer.text).toContain("Do not attempt this part yourself");

    const handed = await env.WP_OS_DB.prepare("SELECT kind, owner_id, description, state FROM work_card WHERE id = ?1")
      .bind(steer.handoffs[0]!.cardId!)
      .first<{ kind: string; owner_id: string; description: string; state: string }>();
    expect(handed).toMatchObject({ kind: "WEB_PROPERTY_CHANGE", owner_id: "aie_porter" });
    expect(handed!.description).toContain("fix the pricing page with the new tiers");
    expect(handed!.description).toContain("wc_handoff");

    const event = await env.WP_OS_DB.prepare("SELECT payload_json FROM event_record WHERE event_type = 'work_card.instruction_handed_off' AND object_id = ?1")
      .bind("wc_handoff")
      .first<{ payload_json: string }>();
    expect(JSON.parse(event!.payload_json)).toMatchObject({ to_kind: "WEB_PROPERTY_CHANGE", to_employee: "Porter" });
  });

  it("is idempotent by title: a second read of the same words, cached or not, never opens a second card", async () => {
    await card("wc_handoff_twice", { prompt: "also fix the pricing page with the new tiers" });
    const make = () =>
      handsOffTo("a packet, and the pricing page separately", "WEB_PROPERTY_CHANGE", "fix the pricing page with the new tiers");
    const first = await steerFor(env, actor(), req("wc_handoff_twice"), make());
    // The SAME words, so this hits the cache branch — resolveHandoffs runs again on the cached
    // interpretation, and must find the existing card rather than opening another.
    const second = await steerFor(env, actor(), req("wc_handoff_twice"), make());
    expect(first.handoffs[0]!.cardId).toBe(second.handoffs[0]!.cardId);
    const rows = await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM work_card WHERE kind = 'WEB_PROPERTY_CHANGE' AND owner_id = 'aie_porter' AND description LIKE '%wc_handoff_twice%'").first<{ n: number }>();
    expect(rows!.n).toBe(1);
  });

  it("fails closed into a CANNOT when no employee is registered for the kind named", async () => {
    await card("wc_handoff_unknown", { prompt: "also do the quarterly LP tax filing" });
    const steer = await steerFor(
      env,
      actor(),
      req("wc_handoff_unknown"),
      handsOffTo("a packet, and the tax filing separately", "LP_TAX_FILING", "file the quarterly LP tax paperwork"),
    );
    expect(steer.handoffs[0]).toMatchObject({ kind: "LP_TAX_FILING", resolved: false, employee: null, cardId: null });
    expect(steer.cannot).toHaveLength(1);
    expect(steer.cannot[0]).toContain("no employee is registered to own \"LP_TAX_FILING\"");
  });

  it("fails closed into a CANNOT when the registered employee is not ACTIVE right now", async () => {
    await env.WP_OS_DB.prepare("UPDATE ai_employee SET status = 'INACTIVE' WHERE id = 'aie_porter'").run();
    try {
      await card("wc_handoff_inactive", { prompt: "also fix the pricing page" });
      const steer = await steerFor(
        env,
        actor(),
        req("wc_handoff_inactive"),
        handsOffTo("a packet, and the pricing page separately", "WEB_PROPERTY_CHANGE", "fix the pricing page"),
      );
      expect(steer.handoffs[0]).toMatchObject({ kind: "WEB_PROPERTY_CHANGE", resolved: false, employee: "Porter", cardId: null });
      expect(steer.cannot[0]).toContain("not available to take it");
    } finally {
      await env.WP_OS_DB.prepare("UPDATE ai_employee SET status = 'ACTIVE' WHERE id = 'aie_porter'").run();
    }
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

// ── Every duty's own step list keeps its hard "never" lines, and adds the same one line ─────────

const A_PARTNER_EXTENDS_SCOPE_LINE =
  "A Managing Partner's own instruction extends what you do here — apply it using judgement and whatever you already have access to, rather than treating it as out of scope. Only decline something that genuinely needs a tool, data source or integration that does not exist anywhere in this system, or that would need to pass through approval regardless of who asked.";

describe("every steerFor caller's declared step list (22 Sep 2026)", () => {
  const namedLists: Array<{ name: string; steps: readonly string[]; hardNever: string | null }> = [
    { name: "HIRE_SEARCH_STEPS", steps: HIRE_SEARCH_STEPS, hardNever: "Nobody is contacted, no interview is arranged and no offer is made — the result is a shortlist he decides on." },
    { name: "DECK_REWORK_STEPS", steps: DECK_REWORK_STEPS, hardNever: "Nothing is sent to a limited partner — a person approves the version first." },
    { name: "BLOG_STEPS", steps: BLOG_STEPS, hardNever: "Send the partner ONE email in the busy-executive format. Nobody outside the firm is contacted and nothing is published." },
    { name: "ARTIFACT_CARD_STEPS", steps: ARTIFACT_CARD_STEPS, hardNever: null },
    { name: "PRODUCTIONS_STEPS", steps: PRODUCTIONS_STEPS, hardNever: "Nobody outside the firm is contacted, nothing is pitched, nothing is booked and no money is committed." },
    { name: "STAGE_STEPS.ROOM", steps: STAGE_STEPS.ROOM, hardNever: "Nothing is booked, nobody outside the firm is contacted, and no money is committed — the result is a proposal a partner decides on." },
    { name: "STAGE_STEPS.WORKSHOP", steps: STAGE_STEPS.WORKSHOP, hardNever: "Nothing is scheduled, nobody outside the firm is contacted, and the result is a proposal a partner decides on." },
  ];

  it.each(namedLists)("$name carries the standing-scope line, byte-identical, and keeps its hard boundary untouched", ({ steps, hardNever }) => {
    expect(steps).toContain(A_PARTNER_EXTENDS_SCOPE_LINE);
    if (hardNever) expect(steps).toContain(hardNever);
  });

  it("the standing-scope line reaches the model's prompt through the ordinary steps path — no separate wiring", () => {
    const prompt = buildInterpretationPrompt({ ...req("wc_steps"), steps: [...HIRE_SEARCH_STEPS], pieces: [{ source: "PROMPT", text: "look up their contact email while you're at it" }] });
    expect(prompt).toContain(A_PARTNER_EXTENDS_SCOPE_LINE);
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
