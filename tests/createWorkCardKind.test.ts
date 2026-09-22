import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { handleRequest } from "../src/worker/index";
import type { Env } from "../src/worker/env";
import { runWebPropertyChangeCard, readWebPropertyChange } from "../src/worker/services/webPropertyChange";
import type { SweepCard } from "../src/worker/services/workSweep";

/**
 * `kind` ON THE CREATE DOOR (Wave B, plan §2/§8).
 *
 * `CreateWorkCardInput` has carried `kind` and `createWorkCardInternal` has written it since 19 Sep
 * — `createWorkCardSchema` simply never accepted it from an HTTP body, so a card typed directly in
 * the OS could only ever become `ARTIFACT`, inferred from her words. This proves the schema fix
 * with a REAL request, not an assumption: before this wave, every one of these bodies would have
 * silently dropped `kind` on the floor the same way `result_recipient`/`preview_first` did.
 *
 * It also proves the two rules the create door has to keep:
 *   · A KIND OPENED BY A JOB CANNOT BE TYPED HERE (`startableByHand`, `shared/work/cardKinds.ts`) —
 *     `duplicateOf()` would silently join a hand-made one to the job's own live card.
 *   · WEB_PROPERTY_CHANGE'S SITE COMES FROM THE `WEB_PROPERTIES` DROPDOWN, NEVER TYPED TEXT — and,
 *     once it does, the card self-heals into a real `web_property_change` row on its first sweep
 *     tick, the same path an email-born card already takes (`runWebPropertyChangeCard`).
 */

let t: TestDb;
let env: Env;

const SEQUOIA = { "x-wpos-dev-user": "sequoia@westpeek.ventures" };

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db, {} as Partial<Env>) as Env;
});

afterAll(async () => {
  await disposeTestDb(t);
});

async function post(body: Record<string, unknown>) {
  return handleRequest(
    new Request("https://os.joinwestpeek.com/api/work-cards", {
      method: "POST",
      headers: { ...SEQUOIA, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
  );
}

describe("kind reaches the server, at last", () => {
  it("writes the kind she chose, hand-startable and unremarkable", async () => {
    const res = await post({ title: "Help Scooter's LinkedIn post land better", kind: "BLOG_HELP" });
    expect(res.status).toBe(201);
    const card = (await res.json()) as { id: string; kind: string };
    expect(card.kind).toBe("BLOG_HELP");
    const row = await t.db.prepare("SELECT kind FROM work_card WHERE id = ?1").bind(card.id).first<{ kind: string }>();
    expect(row!.kind).toBe("BLOG_HELP");
  });

  it("leaves kind unset when she says nothing, same as it always has", async () => {
    const res = await post({ title: "Build me a one-pager on Sensori" });
    expect(res.status).toBe(201);
    const card = (await res.json()) as { id: string; kind: string | null };
    // Inferred from her words, exactly as before this wave — the fix adds a door, it does not
    // remove the one that was already open.
    expect(card.kind).toBe("ARTIFACT");
  });

  it("refuses a kind that is opened by a job, not typed by a person", async () => {
    const res = await post({ title: "Room packet for October", kind: "ROOM_PACKET" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail: string };
    expect(body.detail).toContain("cannot be started by hand");
    // Nothing was silently joined to some other card, either — refused outright.
    const rows = await t.db.prepare("SELECT COUNT(*) AS n FROM work_card WHERE title = ?1").bind("Room packet for October").first<{ n: number }>();
    expect(rows!.n).toBe(0);
  });

  it("refuses an unknown kind the same way", async () => {
    const res = await post({ title: "Something invented", kind: "INVOICE_CHASE" });
    expect(res.status).toBe(400);
  });
});

describe("WEB_PROPERTY_CHANGE's site comes from the dropdown, never typed text", () => {
  it("refuses to open one with no site chosen", async () => {
    const res = await post({ title: "Update the ventures homepage copy", kind: "WEB_PROPERTY_CHANGE" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail: string };
    expect(body.detail).toContain("Pick the site from the list");
  });

  it("refuses a host that is not one of WEB_PROPERTIES, even if it looks real", async () => {
    const res = await post({ title: "Update it", kind: "WEB_PROPERTY_CHANGE", property_host: "westpeek.example.com" });
    expect(res.status).toBe(400);
  });

  it("opens one from the dropdown, and it self-heals into a real web_property_change row on its first tick", async () => {
    const res = await post({
      title: "Fix the broken link on the team page",
      kind: "WEB_PROPERTY_CHANGE",
      property_host: "joinwestpeek.com",
      prompt: "The 'Meet the team' link in the footer 404s — point it at /team.",
    });
    expect(res.status).toBe(201);
    const card = (await res.json()) as { id: string; kind: string };
    expect(card.kind).toBe("WEB_PROPERTY_CHANGE");

    const stored = await t.db
      .prepare("SELECT kind, request_json FROM work_card WHERE id = ?1")
      .bind(card.id)
      .first<{ kind: string; request_json: string | null }>();
    expect(stored!.request_json, "the brief must be on the card, or the sweep has nothing to self-heal from").not.toBeNull();
    const ask = JSON.parse(stored!.request_json!) as { target_repo: string | null; property_host: string | null; ask: string };
    expect(ask.property_host).toBe("joinwestpeek.com");
    expect(ask.target_repo).toBe("join-west-peek-main");
    expect(ask.ask).toContain("footer 404s");

    // Nothing has opened `web_property_change` yet — that is the sweep's job, on its first tick.
    expect(await readWebPropertyChange(env, card.id)).toBeNull();

    const sweepCard: SweepCard = {
      id: card.id,
      title: "Fix the broken link on the team page",
      kind: "WEB_PROPERTY_CHANGE",
      owner_id: null,
      state: "OPEN",
      work_attempts: 0,
      firm_scope: "west-peek",
    };
    await runWebPropertyChangeCard(env, sweepCard);

    const row = await readWebPropertyChange(env, card.id);
    expect(row, "the card must have self-healed a real web_property_change row").not.toBeNull();
    expect(row!.target_repo).toBe("join-west-peek-main");
    expect(row!.property_host).toBe("joinwestpeek.com");
  });
});
