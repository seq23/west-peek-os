import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./helpers/db";
import {
  buildCloseoutPrompt,
  buildRoomDigest,
  parseRoomProposals,
  runRoomCloseout,
} from "../src/worker/services/roomCloseout";
import type { Actor } from "../src/worker/services/authorize";

/**
 * Room close-out (P51).
 *
 * The assertions that matter are the boundaries: West Peek's commitments are recorded and members'
 * are not, and attendance survives an extraction failure — because attendance is the part that
 * cannot be reconstructed a week later.
 */

let t: TestDb;
const actor: Actor = {
  type: "HUMAN", firmUserId: "seq", aiEmployeeId: null, firmScopes: ["west-peek"], roles: ["MANAGING_PARTNER"],
} as unknown as Actor;

beforeAll(async () => {
  t = await createTestDb();
  await t.db.prepare("INSERT INTO person (id, full_name) VALUES ('per_ada','Ada Chen'),('per_dev','Dev Patel'),('per_mo','Mo Diallo')").run();
  for (const [id, title] of [["evt_r1", "The Zero-to-One Room"], ["evt_r2", "Hiring Room"], ["evt_r3", "Capital Room"]]) {
    await t.db.prepare(
      `INSERT INTO evt_event (id, title, event_class, cadence, status, starts_at, created_by)
       VALUES (?1,?2,'ROOM','MONTHLY','LIVE','2027-03-11','seq')`,
    ).bind(id, title).run();
  }
  // Ada hosted, Dev spoke, Mo attended, plus one who never showed.
  await t.db.prepare(
    `INSERT INTO evt_attendee (id, event_id, person_id, display_name, attendee_role, rsvp) VALUES
       ('ea1','evt_r1','per_ada','Ada Chen','HOST','ATTENDED'),
       ('ea2','evt_r1','per_dev','Dev Patel','SPEAKER','ATTENDED'),
       ('ea3','evt_r1','per_mo','Mo Diallo','GUEST','ATTENDED'),
       ('ea4','evt_r1',NULL,'Unknown Guest','GUEST','NO_SHOW')`,
  ).run();
});

afterAll(async () => { await t.mf.dispose(); });

const env = () => ({ WP_OS_DB: t.db } as never);

describe("parsing what the model returned", () => {
  it("forces every commitment to the firm's side", () => {
    // Structural, not a request: there is no way to express a member's obligation.
    const out = parseRoomProposals('{"commitments":[{"commitment_text":"Send the Carta intro deck"}]}');
    expect(out).toHaveLength(1);
    expect(out![0]!.owner_side).toBe("FIRM");
  });

  it("reads a fenced block", () => {
    expect(parseRoomProposals('```json\n{"commitments":[{"commitment_text":"Book the March venue"}]}\n```')).toHaveLength(1);
  });

  it("accepts an empty list as a real answer", () => {
    expect(parseRoomProposals('{"commitments":[]}')).toEqual([]);
  });

  it("returns null on unusable output rather than half a close-out", () => {
    expect(parseRoomProposals("The room went well!")).toBeNull();
  });
});

describe("the prompt draws the line for the model too", () => {
  const prompt = buildCloseoutPrompt(
    { id: "evt_r1", title: "The Zero-to-One Room", event_class: "ROOM", status: "LIVE", summary: null, starts_at: null, firm_scope: "west-peek" },
    "Long notes about the evening and what was decided.",
    "Ada Chen (host)",
  );

  it("tells it not to record what members owe each other", () => {
    expect(prompt).toMatch(/Do NOT list commitments members made to each other/);
    expect(prompt).toMatch(/that is between them/);
  });

  it("requires a quote, and says an empty list is fine", () => {
    expect(prompt).toMatch(/If you cannot quote it, leave it out/);
    expect(prompt).toMatch(/An empty list is a correct answer/);
  });
});

describe("running a close-out", () => {
  it("records attendance as acts, with hosting beating attending", async () => {
    const out = await runRoomCloseout(env(), actor, "evt_r1", "x", {
      synthesise: async () => ({ text: '{"commitments":[]}', aiRunId: "run_1" }),
    });
    expect(out.actsRecorded).toBe(3);

    const acts = await t.db.prepare("SELECT person_id, kind, source FROM com_act WHERE event_id = 'evt_r1' ORDER BY person_id").all<{ person_id: string; kind: string; source: string }>();
    expect(acts.results).toEqual([
      { person_id: "per_ada", kind: "HOSTED", source: "EVENT_CLOSEOUT" },
      { person_id: "per_dev", kind: "SPOKE", source: "EVENT_CLOSEOUT" },
      { person_id: "per_mo", kind: "ATTENDED", source: "EVENT_CLOSEOUT" },
    ]);
  });

  it("refuses a second close-out rather than silently replacing the first", async () => {
    await expect(
      runRoomCloseout(env(), actor, "evt_r1", "x", { synthesise: async () => ({ text: '{"commitments":[]}', aiRunId: null }) }),
    ).rejects.toThrow(/already been closed out/);
  });

  it("keeps attendance even when extraction fails", async () => {
    // The whole point: a model outage must not cost a Room's attendance record, which is the part
    // nobody can reconstruct next week.
    await t.db.prepare("INSERT INTO evt_attendee (id, event_id, person_id, display_name, attendee_role, rsvp) VALUES ('ea5','evt_r2','per_ada','Ada Chen','GUEST','ATTENDED')").run();

    const out = await runRoomCloseout(env(), actor, "evt_r2", "some real notes here to get past the length check", {
      synthesise: async () => { throw new Error("provider down"); },
    });

    expect(out.state).toBe("EXTRACTION_FAILED");
    expect(out.actsRecorded).toBe(1);
    expect(out.detail).toMatch(/Attendance was still recorded/);
    const saved = await t.db.prepare("SELECT acts_recorded, state FROM evt_closeout WHERE event_id = 'evt_r2'").first<{ acts_recorded: number; state: string }>();
    expect(saved).toEqual({ acts_recorded: 1, state: "EXTRACTION_FAILED" });
  });

  it("assigns follow-ups through the shared delegation policy", async () => {
    const out = await runRoomCloseout(env(), actor, "evt_r3",
      "Notes long enough to be treated as real notes for the extraction step.", {
      synthesise: async () => ({
        text: JSON.stringify({ commitments: [
          { commitment_text: "Draft the follow-up summary for attendees" },
          // Wiring money is human-reserved in delegationPolicy — the shared rule must apply here too.
          { commitment_text: "Wire the venue deposit" },
        ] }),
        aiRunId: "run_3",
      }),
    });

    expect(out.commitments).toHaveLength(2);
    const wire = out.commitments.find((c) => c.text.includes("Wire"))!;
    expect(wire.assigneeKind).toBe("HUMAN_RECOMMENDED");
    expect(out.digest).toMatch(/West Peek owes 2 things/);
  });

  it("says so plainly when there were no notes", async () => {
    await t.db.prepare("INSERT INTO evt_event (id, title, event_class, status, created_by) VALUES ('evt_r4','Quiet Room','ROOM','LIVE','seq')").run();
    const out = await runRoomCloseout(env(), actor, "evt_r4", "");
    expect(out.state).toBe("NO_NOTES");
    expect(out.commitments).toEqual([]);
  });
});

describe("the digest", () => {
  const event = { id: "e", title: "The Zero-to-One Room", event_class: "ROOM", status: "COMPLETE", summary: null, starts_at: null, firm_scope: "west-peek" };

  it("treats no follow-ups as a normal outcome, not an empty result", () => {
    const d = buildRoomDigest(event, [], 28);
    expect(d).toMatch(/That is a normal outcome for a Room/);
    expect(d).toMatch(/28 attendance records kept/);
  });

  it("pulls unowned commitments into their own heading", () => {
    const d = buildRoomDigest(event, [
      { text: "Send the deck", assigneeKind: "AI_EMPLOYEE", aiEmployeeId: "Pippa", humanTouchReason: null, dueDate: "2027-03-20" },
      { text: "Decide on next year's venue", assigneeKind: "UNASSIGNED", aiEmployeeId: null, humanTouchReason: null, dueDate: null },
    ], 30);
    expect(d).toMatch(/Send the deck\*\* → Pippa — due 2027-03-20/);
    expect(d).toMatch(/## 1 needs an owner/);
  });

  it("states the boundary on the page a partner actually reads", () => {
    expect(buildRoomDigest(event, [], 5)).toMatch(/Commitments members made to each other are theirs/);
  });
});
