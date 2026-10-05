/**
 * A STOP WITH NO NAMED ADDRESSEE IS ADDRESSED TO THE PARTNER WHO ASKED (5 Oct 2026).
 *
 * Playwright run 36850533285: a card Scooter asked for stopped on `the_brief_is_missing` and his
 * desk said "Needs Sequoia" — the catalogue's `who ?? "SEQUOIA"` default reached `block_who`, and
 * since #201 the desk reads `block_who` first to decide whose "Needs you" it is. `blockCard` now
 * fills a missing `who` from the requester (`requested_by_email`, then `created_by`); the catalogue
 * default survives only for a card no partner asked for, and an explicit `who` always wins.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { createWorkCardInternal } from "../src/worker/services/workCards";
import { blockCard } from "../src/worker/services/blocks";
import { sweepIdentity } from "../src/worker/services/workSweep";
import { needsLabel } from "../src/shared/work/liveStatus";
import type { BlockProvider } from "../src/shared/work/blocks";

let t: TestDb;
let env: Env;
const SEQUOIA = "fu_sequoia_taylor";
const SCOOTER = "fu_scooter_taylor";

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
});
afterAll(async () => { await disposeTestDb(t); });

interface Case {
  name: string;
  requested_by_email: string | null;
  created_by: string | null;
  who?: BlockProvider;
  expectWho: BlockProvider;
  /** Whose desk says "Needs you". */
  needsYou: string;
}

const CASES: Case[] = [
  { name: "made on the page by Scooter", requested_by_email: null, created_by: SCOOTER, expectWho: "SCOOTER", needsYou: SCOOTER },
  { name: "asked for by Scooter by email", requested_by_email: "scooter@westpeek.ventures", created_by: "system:inbound_email", expectWho: "SCOOTER", needsYou: SCOOTER },
  { name: "asked for by Sequoia, typed in by Scooter", requested_by_email: "sequoia@westpeek.ventures", created_by: SCOOTER, expectWho: "SEQUOIA", needsYou: SEQUOIA },
  { name: "made on the page by Sequoia", requested_by_email: null, created_by: SEQUOIA, expectWho: "SEQUOIA", needsYou: SEQUOIA },
  { name: "no partner asked (the sweep made it)", requested_by_email: null, created_by: "system:work_sweep", expectWho: "SEQUOIA", needsYou: SEQUOIA },
  { name: "an explicit who beats the requester", requested_by_email: "scooter@westpeek.ventures", created_by: SCOOTER, who: "SEQUOIA", expectWho: "SEQUOIA", needsYou: SEQUOIA },
];

describe("blockCard addresses an unnamed stop to the partner who asked", () => {
  it("every shape of requester lands on the right partner's desk", async () => {
    let examined = 0;
    for (const c of CASES) {
      const made = await createWorkCardInternal(env, sweepIdentity(), {
        title: `Addressee: ${c.name}`,
        owner_type: "AI",
        owner_id: "aie_wyatt",
        priority: "NORMAL",
        firm_scope: "west-peek",
      });
      await env.WP_OS_DB.prepare("UPDATE work_card SET requested_by_email = ?2, created_by = ?3 WHERE id = ?1")
        .bind(made.id, c.requested_by_email, c.created_by)
        .run();
      await blockCard(env, { id: made.id, title: made.title, firm_scope: "west-peek" }, {
        reason: "the_brief_is_missing",
        trying: made.title,
        employee: "Wyatt",
        ...(c.who ? { who: c.who } : {}),
      });
      const stored = (await env.WP_OS_DB.prepare("SELECT block_who, requested_by_email FROM work_card WHERE id = ?1")
        .bind(made.id)
        .first<{ block_who: string | null; requested_by_email: string | null }>())!;
      expect(stored.block_who, c.name).toBe(c.expectWho);
      const other = c.needsYou === SEQUOIA ? SCOOTER : SEQUOIA;
      expect(needsLabel(stored, c.needsYou).pill, `${c.name}: the requester's desk`).toBe("Needs you");
      expect(needsLabel(stored, other).waitsOn, `${c.name}: the other partner's desk names who it waits on`).not.toBeNull();
      examined += 1;
    }
    // HARD-FAIL ON AN EMPTY LOOP: a table that shrank to nothing would otherwise pass by examining nothing.
    expect(examined).toBe(CASES.length);
    expect(examined).toBeGreaterThanOrEqual(6);
  });
});
