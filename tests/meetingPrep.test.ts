import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import {
  buildDiscrepancyRegister, buildPrepPacket, prepWindow, runWednesdayPrep,
} from "../src/worker/services/meetingPrep";
import { chiefOfStaffFor } from "../src/shared/work/chiefOfStaff";
import { usd } from "../src/shared/fund/sleeveMath";
import type { Env } from "../src/worker/env";
import type { Actor } from "../src/worker/services/authorize";

/**
 * The Wednesday prep packets, and the one rule that decides the whole design.
 *
 * Operator, 9 Sep 2026: "1 employee for each me and scooter needs to send me and scooter prep
 * packets for the wednesday meetings of things we have completed and what is needed. saying nothing
 * was done is okay too."
 *
 * THAT LAST SENTENCE IS AN INSTRUCTION. A truthful empty packet is a legitimate output, so nothing
 * may pad. But an empty packet and a packet that failed to build look IDENTICAL on a screen, and
 * only one of them means a quiet week — so the difference has to be visible on the artifact itself.
 * These tests hold both halves: that an empty week is delivered and says so, and that a week whose
 * sources could not be read is NOT delivered as an empty week.
 *
 * The failure this replaces is real and was in production: the weekly operating review guards its
 * handover with `if (items.length > 0)`, so a week with no derived items produced no deliverable at
 * all — and it addressed its one copy with `ORDER BY u.id LIMIT 1` under a comment about "the
 * senior partner on the roster". Five weekly-review deliverables reached Scooter; one reached
 * Sequoia, on 20 August.
 */

let t: TestDb;
let env: Env;

const SYSTEM: Actor = { type: "SYSTEM", roles: [], firmScopes: ["west-peek"] };

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
});

afterAll(async () => {
  await disposeTestDb(t);
});

/** Both partners, as the seed leaves them. Asserted rather than assumed — the rest depends on it. */
async function partners(): Promise<Array<{ id: string; full_name: string }>> {
  const rows = (
    await env.WP_OS_DB.prepare(
      `SELECT fu.id, fu.full_name FROM firm_user fu
         JOIN firm_user_role fur ON fur.firm_user_id = fu.id
         JOIN role r ON r.id = fur.role_id
        WHERE r.key = 'MANAGING_PARTNER' AND fu.status = 'ACTIVE' ORDER BY fu.full_name`,
    ).all<{ id: string; full_name: string }>()
  ).results ?? [];
  return rows;
}

describe("the window between two syncs", () => {
  it("opens on the previous Wednesday and closes now", () => {
    // Friday 11 Sep 2026, 18:00Z. The previous sync was Wednesday the 9th.
    const w = prepWindow(new Date("2026-09-11T18:00:00.000Z"));
    expect(w.from).toBe("2026-09-09T15:00:00.000Z");
    expect(w.to).toBe("2026-09-11T18:00:00.000Z");
    expect(w.meetingDate).toBe("2026-09-16");
  });

  it("on a Wednesday morning still looks back to LAST Wednesday, not to today", () => {
    // 09:00Z on Wednesday is before the 15:00Z anchor: the sync has not happened yet, so the
    // window that matters is the one since the previous week's.
    const w = prepWindow(new Date("2026-09-16T09:00:00.000Z"));
    expect(w.from).toBe("2026-09-09T15:00:00.000Z");
    expect(w.meetingDate).toBe("2026-09-16");
  });

  it("on a Wednesday AFTERNOON prepares for next week, not for the sync that just ended", () => {
    /*
     * The hour that gets this wrong. Deriving the meeting from `now` — "the next Wednesday at or
     * on today" — returns TODAY at 16:00Z, so the packet would be titled with the date of a
     * meeting that finished an hour ago and would cover that hour. The window and the meeting are
     * one week apart by definition, and this is the only assertion that holds them there.
     */
    const w = prepWindow(new Date("2026-09-09T16:00:00.000Z"));
    expect(w.from).toBe("2026-09-09T15:00:00.000Z");
    expect(w.meetingDate).toBe("2026-09-16");
  });
});

describe("each partner's packet is signed by their own Chief of Staff", () => {
  it("names a different employee for each of the two partners", async () => {
    const people = await partners();
    expect(people.length, "no managing partners to prepare packets for").toBe(2);

    const signed = new Map<string, string>();
    for (const p of people) {
      const packet = await buildPrepPacket(env, p.id, new Date("2026-09-11T18:00:00.000Z"));
      signed.set(p.full_name, packet.preparedBy);
    }
    // "1 employee for each", in her words — not one employee doing both.
    expect(new Set(signed.values()).size, `both packets were signed by the same employee: ${[...signed]}`).toBe(2);
    for (const [name, by] of signed) expect(by).toBe(chiefOfStaffFor(name));
  });
});

describe("an empty packet is delivered, and says it is empty", () => {
  it("states that nothing was completed rather than omitting the section", async () => {
    const people = await partners();
    const packet = await buildPrepPacket(env, people[0]!.id, new Date("2026-09-11T18:00:00.000Z"));

    // A fresh database really is a quiet week — asserted, so this test cannot pass for the wrong
    // reason if the seed ever starts shipping completed work.
    expect(packet.completed.length).toBe(0);
    expect(packet.body).toContain("Nothing was completed in this window");
    expect(packet.body).toContain("## Completed");
  });

  it("carries the coverage block that makes an empty packet believable", async () => {
    const people = await partners();
    const packet = await buildPrepPacket(env, people[0]!.id, new Date("2026-09-11T18:00:00.000Z"));

    /*
     * THE ANTI-EMPTY-LOOP ASSERTION. "Nothing was completed" is only a fact if something was read.
     * A packet that examined zero sources and one that examined eight and found nothing are
     * different documents, and this is the line that tells them apart.
     */
    expect(packet.coverage.length, "the packet examined no sources at all").toBeGreaterThan(0);
    expect(packet.body).toContain("## What was examined");
    for (const c of packet.coverage) expect(packet.body).toContain(c.source);
  });
});

describe("completed work reaches the right partner's packet and only theirs", () => {
  it("lists an approval one partner decided, and does not put it in the other's", async () => {
    const people = await partners();
    const [a, b] = people as [{ id: string; full_name: string }, { id: string; full_name: string }];
    const now = new Date("2026-09-11T18:00:00.000Z");

    await env.WP_OS_DB.prepare(
      `INSERT INTO approval_card (id, action_key, object_type, object_id, title, requested_by_type,
                                  requested_by_id, required_approver_roles_json, state, decided_by, decided_at)
       VALUES ('apc_prep_test', 'company.update', 'canonical_company', 'cc_x',
               'Add Ravenna to the register', 'SYSTEM', 'system', '["MANAGING_PARTNER"]',
               'approved', ?1, '2026-09-10T12:00:00.000Z')`,
    ).bind(a.id).run();

    const mine = await buildPrepPacket(env, a.id, now);
    const theirs = await buildPrepPacket(env, b.id, now);

    expect(mine.completed.some((l) => l.sourceId === "apc_prep_test"), "the decider's packet is missing their own decision").toBe(true);
    expect(mine.body).toContain("Add Ravenna to the register");
    expect(theirs.completed.some((l) => l.sourceId === "apc_prep_test"), "the other partner's packet claimed a decision they did not make").toBe(false);
  });

  it("ignores work completed before the window opened", async () => {
    const people = await partners();
    const a = people[0]!;
    await env.WP_OS_DB.prepare(
      `INSERT INTO approval_card (id, action_key, object_type, object_id, title, requested_by_type,
                                  requested_by_id, required_approver_roles_json, state, decided_by, decided_at)
       VALUES ('apc_prep_old', 'company.update', 'canonical_company', 'cc_y',
               'Something from August', 'SYSTEM', 'system', '["MANAGING_PARTNER"]',
               'approved', ?1, '2026-08-01T12:00:00.000Z')`,
    ).bind(a.id).run();

    const packet = await buildPrepPacket(env, a.id, new Date("2026-09-11T18:00:00.000Z"));
    expect(packet.completed.some((l) => l.sourceId === "apc_prep_old")).toBe(false);
    // And the one inside the window is still there, so this is a window test rather than a
    // "nothing works" test.
    expect(packet.completed.some((l) => l.sourceId === "apc_prep_test")).toBe(true);
  });
});

describe("what is needed is what is actually waiting", () => {
  it("raises an open health fault as something needed, naming it as still down", async () => {
    await env.WP_OS_DB.prepare(
      `INSERT INTO health_fault (id, check_key, label, reading, first_seen_at, firm_scope)
       VALUES ('hf_prep_test', 'planted_for_prep', 'The planted check', '2 failed this week',
               '2026-09-10T00:00:00.000Z', 'west-peek')`,
    ).run();

    const people = await partners();
    const packet = await buildPrepPacket(env, people[0]!.id, new Date("2026-09-11T18:00:00.000Z"));
    const line = packet.needed.find((l) => l.sourceId === "planted_for_prep");
    expect(line, "an open fault did not reach the packet").toBeTruthy();
    expect(line!.text).toContain("Still down");
    expect(packet.body).toContain("The planted check");
  });
});

describe("the fund-deck discrepancy register", () => {
  it("hard-fails rather than reporting a clean deck when there is nothing to examine", async () => {
    /*
     * THE EMPTY-LOOP GUARD, ASSERTED DIRECTLY. A register that returns "no discrepancies found"
     * because the fund has no policy rows is the exact defect this repo hunts: a stage that exits
     * having done nothing, wearing a green light. The test database has no fund at this point.
     */
    await expect(buildDiscrepancyRegister(env)).rejects.toThrow(/no fund|examined nothing/i);
  });

  it("recovers a recorded note and separates it from what this run derived", async () => {
    // A fund carrying exactly the shape production carries: a sleeve policy whose note records the
    // deck's own contradictions, and a mandate whose open question was dropped by the next version.
    await env.WP_OS_DB.prepare(
      "INSERT INTO fund (id, name, status, firm_scope) VALUES ('fund_test', 'Test Fund I', 'ACTIVE', 'west-peek')",
    ).run();
    await env.WP_OS_DB.prepare(
      `INSERT INTO investment_mandate_version (id, fund_id, version_no, effective_from, mandate_json, created_by)
       VALUES ('imv1', 'fund_test', 1, '2026-08-18', ?1, 'system')`,
    ).bind(JSON.stringify({
      target_positions: 20,
      check_size_usd: { min: 500_000, max: 750_000 },
      open_question: "Deck p4 lists one sector set; the Terms page lists another.",
    })).run();
    await env.WP_OS_DB.prepare(
      `INSERT INTO investment_mandate_version (id, fund_id, version_no, effective_from, mandate_json, created_by)
       VALUES ('imv2', 'fund_test', 2, '2026-08-21', ?1, 'system')`,
    ).bind(JSON.stringify({
      target_positions: 20,
      check_size_usd: { min: 500_000, max: 750_000 },
    })).run();
    await env.WP_OS_DB.prepare(
      `INSERT INTO sleeve_policy_version (id, fund_id, version_no, effective_from, sleeve_json, created_by)
       VALUES ('spv1', 'fund_test', 1, '2026-08-18', ?1, 'system')`,
    ).bind(JSON.stringify({
      estimated_investable_usd: 24_000_000,
      sleeves: [
        { key: "EARLY_STAGE_PRIMARY", target_pct: 70, target_usd: 17_000_000 },
        { key: "SECONDARY_PURCHASE", target_pct: 30, target_usd: 7_000_000 },
      ],
      note: "The deck's construction table sums to $27M of a $30M fund.",
    })).run();
    await env.WP_OS_DB.prepare(
      `INSERT INTO reserve_policy_version (id, fund_id, version_no, effective_from, reserve_json, created_by)
       VALUES ('rpv1', 'fund_test', 1, '2026-08-18', ?1, 'system')`,
    ).bind(JSON.stringify({ reserve_pct: 40, basis: "early-stage sleeve" })).run();

    const reg = await buildDiscrepancyRegister(env);

    // Recovered, not re-derived: the sleeve note comes back word for word.
    expect(reg.recorded.some((d) => d.what.includes("sums to $27M of a $30M fund"))).toBe(true);

    /*
     * THE DROPPED QUESTION, WHICH IS THE FINDING NOBODY WAS GOING TO NOTICE. The policy tables are
     * immutable and versioned so a change is visible; what changed here was the disappearance of
     * the only record that a question was open, with no answer recorded anywhere.
     */
    const q = reg.recorded.find((d) => d.what.includes("Deck p4"));
    expect(q, "the dropped open question was not recovered").toBeTruthy();
    expect(q!.actedOn).toMatch(/NOT resolved, DROPPED/);

    // Derived and recorded stay apart, and the arithmetic actually ran.
    expect(reg.derived.length, "no arithmetic check produced anything").toBeGreaterThan(0);
    /*
     * 70% of $24M is $16.8M against a stored $17M. Figures print through the one formatter in
     * `sleeveMath.usd`, which strips trailing zeros — so this is "$17M", not "$17.0M". Asserted on
     * the formatter's output rather than on a hand-written string, because two ways of writing the
     * same number on one screen is the smaller cousin of the bug this whole file is about.
     */
    expect(
      reg.derived.some((d) => d.what.includes(usd(16_800_000)) && d.what.includes(usd(17_000_000))),
      `no sleeve mismatch was reported; derived items were: ${reg.derived.map((d) => d.where).join(", ")}`,
    ).toBe(true);
    // 20 positions at $500-750K needs $10.0M-$15.0M; the sleeve leaves $10.2M after 40% reserves.
    expect(reg.derived.some((d) => d.what.includes("positions"))).toBe(true);

    expect(reg.body).toContain("Already found, and recorded at the time");
    expect(reg.body).toContain("Newly noticed by this run");
    for (const d of [...reg.recorded, ...reg.derived]) expect(reg.body).toContain(d.where);
  });
});

describe("the run hands everything over and every employee reports", () => {
  it("delivers a packet per partner and the register, and announces each one", async () => {
    const out = await runWednesdayPrep(env, SYSTEM, new Date("2026-09-11T18:00:00.000Z"));

    expect(out.failures, `the run reported failures: ${JSON.stringify(out.failures)}`).toEqual([]);
    expect(out.packets.length).toBe(2);
    expect(out.register).not.toBeNull();

    const delivered = (
      await env.WP_OS_DB.prepare(
        "SELECT kind, prepared_by, prepared_for FROM deliverable WHERE kind IN ('meeting_prep','discrepancy_list')",
      ).all<{ kind: string; prepared_by: string; prepared_for: string }>()
    ).results ?? [];

    const packets = delivered.filter((d) => d.kind === "meeting_prep");
    expect(packets.length, "one packet per partner").toBe(2);
    // Two employees, not one doing both.
    expect(new Set(packets.map((d) => d.prepared_by)).size).toBe(2);
    // Each addressed to a different person: the whole point of the change.
    expect(new Set(packets.map((d) => d.prepared_for)).size).toBe(2);

    const register = delivered.filter((d) => d.kind === "discrepancy_list");
    expect(register.length, "the register did not reach both partners").toBe(2);
    expect(new Set(register.map((d) => d.prepared_by))).toEqual(new Set(["Preston"]));

    /*
     * EVERY EMPLOYEE REPORTS COMPLETION — her instruction, in capitals. A deliverable sitting on a
     * page with nothing announcing it is a file somebody has to go and find, not a report.
     */
    const notices = (
      await env.WP_OS_DB.prepare(
        "SELECT title, firm_user_id FROM notification WHERE kind = 'MEETING' AND dedupe_key LIKE '%2026-09-16%'",
      ).all<{ title: string; firm_user_id: string | null }>()
    ).results ?? [];
    expect(notices.length, "nothing announced any of the three handovers").toBeGreaterThanOrEqual(4);
    expect(notices.every((n) => Boolean(n.firm_user_id)), "a handover notice was addressed to nobody").toBe(true);

    // And it lands on the spine, per employee.
    const events = (
      await env.WP_OS_DB.prepare(
        "SELECT event_type, actor_id FROM event_record WHERE event_type IN ('meeting_prep.delivered','discrepancy_register.delivered')",
      ).all<{ event_type: string; actor_id: string }>()
    ).results ?? [];
    expect(new Set(events.map((e) => e.actor_id)).size, "fewer than three employees reported completion").toBe(3);
  });

  it("re-running updates the same packets rather than stacking copies", async () => {
    await runWednesdayPrep(env, SYSTEM, new Date("2026-09-11T19:00:00.000Z"));
    const n = await env.WP_OS_DB.prepare(
      "SELECT COUNT(*) AS n FROM deliverable WHERE kind = 'meeting_prep'",
    ).first<{ n: number }>();
    expect(n!.n).toBe(2);
  });
});
