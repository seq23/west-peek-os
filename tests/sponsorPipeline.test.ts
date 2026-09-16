import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, type TestDb } from "./helpers/db";
import { handleListSponsors } from "../src/worker/services/sponsors";

/**
 * A declined packet's research leaves the pipeline table. On 15 Sep 2026 "Who is paying for it"
 * listed Harvey three times at three prices — one row per pass of a Room rebuilt twice — beside a
 * dozen sponsors nobody would now approach. Research stays on the record with its packet; the
 * table shows what is being pursued.
 */

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();
  await t.db.batch([
    t.db.prepare(`INSERT INTO evt_room_packet (id, title, theme, proposed_for_month, created_by, status) VALUES
      ('rpk_kept','The First Read','counsel','2026-10','Parker','APPROVED'),
      ('rpk_gone','First Counsel, First Look','counsel','2026-10','Parker','DECLINED')`),
    t.db.prepare(`INSERT INTO evt_sponsor_prospect (id, org_name, tier, category, ask_low_usd, ask_high_usd, stage, packet_id, firm_scope, created_by) VALUES
      ('sp_1','Harvey','PRESENTING','LEGAL',20000,22000,'IDENTIFIED','rpk_kept','west-peek','Parker'),
      ('sp_2','Harvey AI','PRESENTING','LEGAL',20000,24000,'IDENTIFIED','rpk_gone','west-peek','Parker'),
      ('sp_3','Cooley LLP','SUPPORTING','LEGAL',10000,12000,'RESEARCHING','rpk_gone','west-peek','Parker'),
      ('sp_4','NAMWOLF','SUPPORTING','LEGAL',10000,12000,'DRAFTED','rpk_gone','west-peek','Parker'),
      ('sp_5','Carta','SUPPORTING','EQUITY_CAPTABLE',8000,10000,'IDENTIFIED',NULL,'west-peek','seq')`),
  ]);
});

afterAll(async () => { await disposeTestDb(t); });

describe("who is paying for it", () => {
  it("shows the live packet's prospects, anything somebody actually moved, and hand-added ones — not a declined packet's untouched research", async () => {
    const res = await handleListSponsors({ request: new Request("https://os/api/sponsors"), env: { WP_OS_DB: t.db } as never, identity: null, params: {} });
    const body = (await res.json()) as { sponsors: { org_name: string; packet_id: string | null }[] };
    expect(body.sponsors.map((s) => s.org_name).sort()).toEqual(["Carta", "Harvey", "NAMWOLF"]);
    // The declined packet's rows are still on the record for the packet itself.
    const kept = await t.db.prepare("SELECT COUNT(*) AS n FROM evt_sponsor_prospect WHERE packet_id = 'rpk_gone'").first<{ n: number }>();
    expect(kept?.n).toBe(3);
  });
});
