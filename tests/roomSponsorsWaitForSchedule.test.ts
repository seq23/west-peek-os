import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { actorFromIdentity } from "../src/worker/services/authorize";
import { sweepIdentity } from "../src/worker/services/workSweep";
import { scheduleRoom } from "../src/worker/services/roomPacket";
import { advanceSponsor, createSponsor, handleListSponsors, SponsorError } from "../src/worker/services/sponsors";

/**
 * A ROOM'S SPONSORS WAIT FOR ITS DATE (owner approved the v8 mock-up, 23 Oct 2026).
 *
 * The flow is Idea → Proposed → Kept for later → Scheduled. Before this, Parker's suggested sponsors
 * were written IDENTIFIED — straight into the live pipeline — the moment a packet was BUILT, so a
 * Room nobody had kept, let alone dated, already had a "pipeline". Now:
 *
 *   1. building a packet writes its sponsors PARKED (the full build is pinned in roomRequest.test.ts);
 *   2. a sponsor on a Room with no date cannot be drafted, sent, put in conversation or committed;
 *   3. a sponsor added to an unscheduled Room is PARKED with the others;
 *   4. "Schedule this Room" (`scheduleRoom`) is the one step that makes them live: IDENTIFIED, on the
 *      Room's event, where the one-category-per-Room rule reads them.
 *
 * Proved negatively when written: with the insert put back to 'IDENTIFIED' in roomPacket.ts the
 * source pin below and roomRequest.test.ts's PARKED assertion fail; with the un-park UPDATE removed
 * from `scheduleRoom`, test 4 fails.
 */

let t: TestDb;
let env: Env;
const actor = () => actorFromIdentity({ ...sweepIdentity(), id: "fu_sequoia_taylor" });

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db, {} as Partial<Env>);
  await t.db.batch([
    t.db.prepare(`INSERT INTO evt_room_packet (id, title, theme, proposed_for_month, created_by, status, format, target_min, target_max) VALUES
      ('rpk_kept','The Record Room','records','2026-11','Parker','APPROVED','DINNER',25,35),
      ('rpk_gone','The Clear-Eyed Room','clarity','2026-08','Parker','DECLINED','DINNER',25,35)`),
    t.db.prepare(`INSERT INTO evt_sponsor_prospect (id, org_name, tier, category, ask_low_usd, ask_high_usd, stage, packet_id, firm_scope, created_by, rank) VALUES
      ('sp_harvey','Harvey','PRESENTING','LEGAL',20000,20000,'PARKED','rpk_kept','west-peek','Parker',1),
      ('sp_bank','Western Alliance Bank','SUPPORTING','BANKING',11000,11000,'PARKED','rpk_kept','west-peek','Parker',2),
      ('sp_old','Old Suggestion','SUPPORTING','LEGAL',5000,5000,'PARKED','rpk_gone','west-peek','Parker',1)`),
  ]);
});

afterAll(async () => { await disposeTestDb(t); });

const stageOf = async (id: string): Promise<{ stage: string; event_id: string | null }> =>
  (await env.WP_OS_DB.prepare("SELECT stage, event_id FROM evt_sponsor_prospect WHERE id = ?1").bind(id).first<{ stage: string; event_id: string | null }>())!;

describe("a Room's sponsors wait, parked, until it is scheduled", () => {
  it("1 · the packet build writes Parker's sponsors PARKED, never IDENTIFIED", () => {
    const src = readFileSync(new URL("../src/worker/services/roomPacket.ts", import.meta.url), "utf8");
    const insert = src.slice(src.indexOf("INSERT INTO evt_sponsor_prospect"), src.indexOf("INSERT INTO evt_sponsor_prospect") + 600);
    expect(insert).toContain("VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'PARKED',");
    expect(insert).not.toContain("'IDENTIFIED'");
    // A rebuild replaces Parker's own earlier suggestions, parked or not, and nothing a person moved.
    expect(src).toContain("DELETE FROM evt_sponsor_prospect WHERE packet_id = ?1 AND stage IN ('IDENTIFIED','PARKED')");
  });

  it("2 · nobody works a sponsor for a Room with no date: drafted, sent, in conversation and committed are refused", async () => {
    for (const stage of ["IDENTIFIED", "DRAFTED", "SENT", "IN_CONVERSATION"] as const) {
      const err = await advanceSponsor(env, actor(), "sp_harvey", { stage }).catch((e: unknown) => e);
      expect(err, stage).toBeInstanceOf(SponsorError);
      expect((err as SponsorError).code, stage).toBe("room_not_scheduled");
      expect((err as SponsorError).message).toMatch(/The Record Room has no date yet/);
    }
    const committed = await advanceSponsor(env, actor(), "sp_harvey", { stage: "COMMITTED", committed_usd: 20000 }).catch((e: unknown) => e);
    expect((committed as SponsorError).code).toBe("room_not_scheduled");
    expect((await stageOf("sp_harvey")).stage).toBe("PARKED");
  });

  it("3 · a sponsor added to an unscheduled Room is parked with the others, on no event", async () => {
    const added = await createSponsor(env, actor(), { org_name: "Rippling", tier: "SUPPORTING", category: "PAYROLL_HR", packet_id: "rpk_kept" });
    expect(added.stage).toBe("PARKED");
    expect(added.event_id).toBeNull();
    // A sponsor tied to no Room is on the list as before.
    const loose = await createSponsor(env, actor(), { org_name: "Carta", tier: "SUPPORTING", category: "EQUITY_CAPTABLE" });
    expect(loose.stage).toBe("IDENTIFIED");
  });

  it("4 · Schedule this Room makes every parked sponsor live, on the Room's event — and only this Room's", async () => {
    const { packet, eventId } = await scheduleRoom(env, actor(), "rpk_kept", { startsAt: "2026-11-19T23:00:00.000Z", location: "SAGA" });
    expect(packet.status).toBe("SCHEDULED");
    for (const id of ["sp_harvey", "sp_bank"]) {
      expect(await stageOf(id), id).toEqual({ stage: "IDENTIFIED", event_id: eventId });
    }
    const rippling = (await env.WP_OS_DB.prepare("SELECT stage, event_id FROM evt_sponsor_prospect WHERE org_name = 'Rippling'").first<{ stage: string; event_id: string }>())!;
    expect(rippling).toEqual({ stage: "IDENTIFIED", event_id: eventId });
    // Another Room's parked sponsor is untouched.
    expect((await stageOf("sp_old")).stage).toBe("PARKED");
    // Now it can be worked, and a second sponsor in a held category is refused (the Rooms rule, kept).
    expect((await advanceSponsor(env, actor(), "sp_harvey", { stage: "DRAFTED" })).stage).toBe("DRAFTED");
    const clash = await createSponsor(env, actor(), { org_name: "Clio", tier: "SUPPORTING", category: "LEGAL", packet_id: "rpk_kept" }).catch((e: unknown) => e);
    expect((clash as SponsorError).code).toBe("category_conflict");
    const ev = (await env.WP_OS_DB.prepare("SELECT payload_json FROM event_record WHERE event_type = 'room_packet.scheduled' AND object_id = ?1").bind(eventId).first<{ payload_json: string }>())!;
    expect(JSON.parse(ev.payload_json).sponsors_made_live).toBe(3);
  });

  it("5 · the sponsors list names each sponsor's Room, and leaves out a turned-down Room's parked suggestions", async () => {
    const res = await handleListSponsors({ request: new Request("https://os/api/sponsors"), env, identity: null, params: {} });
    const body = (await res.json()) as { sponsors: Array<{ org_name: string; packet_title: string | null; packet_status: string | null; packet_month: string | null }> };
    const names = body.sponsors.map((s) => s.org_name).sort();
    expect(names).toEqual(["Carta", "Harvey", "Rippling", "Western Alliance Bank"]);
    const harvey = body.sponsors.find((s) => s.org_name === "Harvey")!;
    expect(harvey).toMatchObject({ packet_title: "The Record Room", packet_status: "SCHEDULED", packet_month: "2026-11" });
  });
});
