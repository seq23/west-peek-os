import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { CARDS_PER_HOUR_TRIP, createWorkCardInternal } from "../src/worker/services/workCards";
import type { Env } from "../src/worker/env";
import type { FirmUserIdentity } from "../src/worker/auth";

/**
 * A NAME AND AN ID ARE NOT THE SAME VALUE, AND THE RATE LIMITER WAS COMPARING THE WRONG ONE.
 *
 * `createWorkCardInternal` resolves an AI owner's display name to their seat id — "Wyatt" becomes
 * `aie_wyatt` — because that is what `work_card.owner_id` holds and what `runEmployeeWork` looks up.
 * The duplicate guard was moved above that resolution after it silently stopped guarding for the
 * email-intake route. The RATE LIMIT two lines below it was left reading the raw input.
 *
 * So `rateTrip` ran `WHERE owner_id = 'Wyatt'` against a column full of `aie_wyatt` and counted zero,
 * every time, for every machine route — and every machine route names its employee by display string
 * (`DEAL_INTAKE_EMPLOYEE`, `ROUTING_EMPLOYEE`, `PORTFOLIO_UPDATE_EMPLOYEE`, `IC_FACILITATOR`). The
 * breaker was dead for exactly the unattended callers it exists to stop; a partner opening cards by
 * hand was never the risk.
 *
 * This plants the trip condition under the STORED shape and opens a card under the DISPLAY shape.
 * Before the fix the card was created and nothing was said.
 */

let t: TestDb;
let env: Env;

const SYSTEM: FirmUserIdentity = {
  id: "system:test_intake",
  email: "os@joinwestpeek.com",
  fullName: "Inbound mail",
  status: "ACTIVE",
  roles: ["MANAGING_PARTNER"],
  authorityScopes: [{ scopeKey: "firm_scope", scopeValue: "west-peek" }],
};

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
});

afterAll(async () => {
  await disposeTestDb(t);
});

/** Cards written straight to D1 in the shape the column really holds. */
async function plantCards(ownerId: string, n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await env.WP_OS_DB.prepare(
      `INSERT INTO work_card (id, title, owner_type, owner_id, state, priority, firm_scope, created_by)
       VALUES (?1, ?2, 'AI', ?3, 'OPEN', 'NORMAL', 'west-peek', 'system:test_intake')`,
    )
      .bind(`wc_plant_${i}_${crypto.randomUUID()}`, `planted ${i}`, ownerId)
      .run();
  }
}

describe("the runaway-employee breaker counts the owner the column actually holds", () => {
  it("trips on a caller that names the employee by their display name", async () => {
    const seat = await env.WP_OS_DB.prepare("SELECT id, name FROM ai_employee WHERE name = 'Wyatt'").first<{
      id: string;
      name: string;
    }>();
    // Guards the guard: if the seat ever stops being id-shaped this test proves nothing.
    expect(seat?.id).toBe("aie_wyatt");

    await plantCards("aie_wyatt", CARDS_PER_HOUR_TRIP);

    await expect(
      createWorkCardInternal(env, SYSTEM, {
        // The display string, exactly as DEAL_INTAKE_EMPLOYEE hands it over.
        title: "Deal flow: a company that arrived while Wyatt was looping",
        owner_type: "AI",
        owner_id: "Wyatt",
        machine_id: undefined,
      }),
    ).rejects.toMatchObject({ status: 429, code: "opening_too_fast" });
  });

  it("says who is looping by name, not by seat id — the refusal is read by a partner", async () => {
    let message = "";
    try {
      await createWorkCardInternal(env, SYSTEM, {
        title: "Deal flow: a second company, also while looping",
        owner_type: "AI",
        owner_id: "Wyatt",
        machine_id: undefined,
      });
    } catch (err) {
      message = (err as Error).message;
    }
    // Counted by id, said by name. "aie_wyatt has opened 20 work cards" is a sentence a partner has
    // to decode before she can act on it.
    expect(message).toMatch(/^Wyatt has opened \d+ work cards/);
    expect(message).not.toContain("aie_wyatt");
  });

  it("leaves an unnamed owner alone, because a card with no owner cannot be looping", async () => {
    const card = await createWorkCardInternal(env, SYSTEM, {
      title: "Something a partner typed herself",
      machine_id: undefined,
    });
    expect(card.id).toMatch(/^wc_/);
  });
});
