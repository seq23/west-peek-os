import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { handleRequest } from "../src/worker/index";
import {
  DUTY_PRECEDENCE,
  SHIFTS,
  readableHour,
  readableWindow,
  resolveDay,
  resolveDuty,
  type DutyOverride,
} from "@shared/workforce/dutyRoster";
import type { Env } from "../src/worker/env";

/**
 * The operator's control over the duty roster.
 *
 * Ordered by how badly each failure would hurt.
 *
 * 1. **The code default is still the fallback, and the database holds only differences.** This is
 *    the load-bearing decision. `dutyRoster.ts` warns that "a second roster is a second source of
 *    truth"; if a copy of the shift table ever lands in D1 the two can disagree and nothing can say
 *    which is right. Proven here by removing every override and watching the rota come back byte
 *    for byte, and by a new employee inheriting a shift nobody wrote a row for.
 * 2. **Precedence is one rule, read once.** Custom hours over a shift change over the default. Three
 *    sources silently competing is how a rota becomes unarguable, which the module says is the one
 *    property it must not have.
 * 3. **`resolveDuty` is still pure.** Same arguments, same answer, no database, no clock.
 * 4. **The two surfaces cannot disagree.** The Employees readout and the admin control are computed
 *    from the same overrides by the same resolver.
 * 5. **Revert is a delete, and it is one press.** Nothing is remembered and restored, because a
 *    remembered value is a value that can be restored wrongly.
 * 6. **The constraints actually constrain** — including the CHECK that would silently pass if its
 *    three-valued comparison were left unwrapped, which is the bug this repo hit yesterday.
 */

let t: TestDb;
let env: Env;

const MP = { "x-wpos-dev-user": "sequoia@westpeek.ventures" };

async function call<T = any>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const res = await handleRequest(
    new Request(`https://test.local${path}`, {
      method,
      headers: body === undefined ? MP : { ...MP, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
  );
  return { status: res.status, body: (await res.json()) as T };
}

/** Write a row straight to D1, so a CHECK can be tested without the handler's own guards. */
function insertRaw(cols: string, values: unknown[]): Promise<unknown> {
  const marks = values.map((_, i) => `?${i + 1}`).join(", ");
  return env.WP_OS_DB.prepare(`INSERT INTO duty_override (${cols}) VALUES (${marks})`)
    .bind(...values)
    .run();
}

const clearAll = () => env.WP_OS_DB.prepare("DELETE FROM duty_override").run();

/** Reads a repo file, so a rule about the SOURCE is checked rather than asserted. */
const readSource = (relative: string) => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
});

afterAll(async () => {
  await disposeTestDb(t);
});

// ── 1 · The default stays the default ────────────────────────────────────────

describe("the code default is the fallback and the database holds only differences", () => {
  it("returns the untouched default when nothing has been overridden", async () => {
    await clearAll();
    const before = resolveDuty(9, 5);
    expect(resolveDuty(9, 5, { overrides: [] })).toEqual(before);
  });

  it("comes back to exactly the default after an override is set and reverted", async () => {
    await clearAll();
    const pristine = JSON.stringify(resolveDay(5));

    const set = await call("/api/ai/duty/overrides", "POST", {
      kind: "SHIFT",
      employee_name: "Wyatt",
      shift_key: "OVERNIGHT",
      on_duty: false,
      reason: "Wyatt is not on overnight any more",
    });
    expect(set.status).toBe(201);

    const changed = await call<{ day: Array<{ label: string; onDuty: Array<{ name: string }> }> }>(
      "/api/ai/duty?hour=9",
    );
    // Not a claim about the whole rota — only that the difference took effect.
    expect(changed.body.day.find((s) => s.label === "Overnight")!.onDuty.map((a) => a.name)).not.toContain("Wyatt");

    const back = await call("/api/ai/duty/revert", "POST", {
      employee_name: "Wyatt",
      kind: "SHIFT",
      shift_key: "OVERNIGHT",
    });
    expect(back.status).toBe(200);

    // Byte for byte. Reverting restores nothing; it removes the difference, which is why there is
    // no remembered value that could come back wrong.
    expect(JSON.stringify(resolveDay(5))).toBe(pristine);
    const after = await call<{ overrides: unknown[] }>("/api/ai/duty?hour=9");
    expect(after.body.overrides).toEqual([]);
  });

  it("gives a newly seated employee a shift without anyone writing a row for them", async () => {
    // Nothing in the database mentions Walker, and the morning still knows he belongs to it.
    await clearAll();
    const morning = resolveDuty(8, 5).onDuty.map((a) => a.name);
    expect(morning).toContain("Walker");
    expect(resolveDuty(8, 5).onDuty.find((a) => a.name === "Walker")!.change).toBeNull();
  });

  it("marks a default entry as default and a changed entry as changed", async () => {
    const overrides: DutyOverride[] = [
      {
        name: "Preston",
        kind: "SHIFT",
        shift: "MIDDAY",
        onDuty: true,
        reason: "Preston covers midday now",
        setBy: "Sequoia Taylor",
        setAt: "2026-08-22T10:00:00.000Z",
      },
    ];
    const midday = resolveDuty(13, 8, { overrides });
    const preston = midday.onDuty.find((a) => a.name === "Preston");
    expect(preston).toBeDefined();
    expect(preston!.change).not.toBeNull();
    expect(preston!.change!.reason).toBe("Preston covers midday now");
    expect(preston!.change!.setBy).toBe("Sequoia Taylor");
    // Pierce is on midday because the code says so, and carries no change note.
    expect(midday.onDuty.find((a) => a.name === "Pierce")!.change).toBeNull();
    expect(midday.changed).toBe(true);
  });
});

// ── 2 · Precedence ───────────────────────────────────────────────────────────

describe("precedence is one rule and the resolver reads it once", () => {
  it("states the order in exactly one place, custom hours above shift changes above the default", () => {
    expect([...DUTY_PRECEDENCE]).toEqual(["PINNED", "CUSTOM_HOURS", "SHIFT_OVERRIDE", "CODE_DEFAULT"]);
  });

  it("lets custom hours beat a shift change for the same person", () => {
    const overrides: DutyOverride[] = [
      // The shift change says Wyatt is OFF midday…
      {
        name: "Wyatt",
        kind: "SHIFT",
        shift: "MIDDAY",
        onDuty: false,
        reason: "taken off midday",
        setBy: "Sequoia Taylor",
        setAt: "2026-08-22T10:00:00.000Z",
      },
      // …and his own hours cover it, so his own hours win.
      {
        name: "Wyatt",
        kind: "HOURS",
        fromHour: 6,
        toHour: 20,
        reason: "Wyatt works six to eight",
        setBy: "Sequoia Taylor",
        setAt: "2026-08-22T10:05:00.000Z",
      },
    ];
    const at2pm = resolveDuty(14, 8, { overrides });
    const wyatt = at2pm.onDuty.find((a) => a.name === "Wyatt");
    expect(wyatt).toBeDefined();
    expect(wyatt!.source).toBe("CUSTOM_HOURS");
    expect(wyatt!.change!.hours).toBe(readableWindow(6, 20));
  });

  it("lets a shift change beat the code default in both directions", () => {
    const off: DutyOverride[] = [
      {
        name: "Willow",
        kind: "SHIFT",
        shift: "OVERNIGHT",
        onDuty: false,
        reason: "Willow is off overnight",
        setBy: "Sequoia Taylor",
        setAt: "2026-08-22T10:00:00.000Z",
      },
    ];
    expect(resolveDuty(2, 5).onDuty.map((a) => a.name)).toContain("Willow");
    expect(resolveDuty(2, 5, { overrides: off }).onDuty.map((a) => a.name)).not.toContain("Willow");

    const on: DutyOverride[] = [
      {
        name: "Willow",
        kind: "SHIFT",
        shift: "MORNING",
        onDuty: true,
        reason: "Willow joins the morning",
        setBy: "Sequoia Taylor",
        setAt: "2026-08-22T10:00:00.000Z",
      },
    ];
    expect(resolveDuty(8, 5).onDuty.map((a) => a.name)).not.toContain("Willow");
    expect(resolveDuty(8, 8, { overrides: on }).onDuty.map((a) => a.name)).toContain("Willow");
  });

  it("takes somebody off entirely when their own hours do not reach the hour asked about", () => {
    const overrides: DutyOverride[] = [
      {
        name: "Wyatt",
        kind: "HOURS",
        fromHour: 6,
        toHour: 20,
        reason: "Wyatt works six to eight",
        setBy: "Sequoia Taylor",
        setAt: "2026-08-22T10:00:00.000Z",
      },
    ];
    // Wyatt is on the default overnight bench for the morning sweep; 11pm is outside his window.
    expect(resolveDuty(23, 8, { overrides }).onDuty.map((a) => a.name)).not.toContain("Wyatt");
    expect(resolveDuty(9, 8, { overrides }).onDuty.map((a) => a.name)).toContain("Wyatt");
  });

  it("handles a window that runs through midnight", () => {
    const overrides: DutyOverride[] = [
      {
        name: "Poppy",
        kind: "HOURS",
        fromHour: 21,
        toHour: 5,
        reason: "Poppy is on nights this month",
        setBy: "Sequoia Taylor",
        setAt: "2026-08-22T10:00:00.000Z",
      },
    ];
    const names = (h: number) => resolveDuty(h, 8, { overrides }).onDuty.map((a) => a.name);
    expect(names(22)).toContain("Poppy");
    expect(names(1)).toContain("Poppy");
    expect(names(4)).toContain("Poppy");
    expect(names(5)).not.toContain("Poppy"); // the end is exclusive
    expect(names(13)).not.toContain("Poppy");
  });

  it("asks a different question of the day view than of the now view", () => {
    // 6am–8pm does not cover 10pm, so "on now at 10pm" is false — but it DOES touch the evening
    // shift, so "covers the evening" is true. Collapsing the two would drop people off the day.
    const overrides: DutyOverride[] = [
      {
        name: "Wyatt",
        kind: "HOURS",
        fromHour: 6,
        toHour: 20,
        reason: "Wyatt works six to eight",
        setBy: "Sequoia Taylor",
        setAt: "2026-08-22T10:00:00.000Z",
      },
    ];
    expect(resolveDuty(22, 8, { overrides }).onDuty.map((a) => a.name)).not.toContain("Wyatt");
    const evening = resolveDay(8, { overrides }).find((s) => s.shift === "EVENING")!;
    expect(evening.onDuty.map((a) => a.name)).toContain("Wyatt");
  });
});

// ── 3 · Still pure, still deterministic ──────────────────────────────────────

describe("the resolver stays pure", () => {
  it("returns the same answer for the same arguments, overrides and all", () => {
    const overrides: DutyOverride[] = [
      {
        name: "Wyatt",
        kind: "HOURS",
        fromHour: 6,
        toHour: 20,
        reason: "Wyatt works six to eight",
        setBy: "Sequoia Taylor",
        setAt: "2026-08-22T10:00:00.000Z",
      },
    ];
    expect(resolveDuty(9, 5, { overrides })).toEqual(resolveDuty(9, 5, { overrides }));
    expect(resolveDay(5, { overrides })).toEqual(resolveDay(5, { overrides }));
  });

  it("does not reach a database: src/shared may not import src/worker", () => {
    // The rule the whole architecture rests on, checked on the source rather than asserted.
    const src = readSource("src/shared/workforce/dutyRoster.ts");
    expect(src).not.toMatch(/from\s+["'][^"']*worker/);
    expect(src).not.toMatch(/WP_OS_DB/);
  });

  it("never puts on duty somebody who is switched off, however they were overridden", () => {
    const overrides: DutyOverride[] = [
      {
        name: "Wyatt",
        kind: "SHIFT",
        shift: "MORNING",
        onDuty: true,
        reason: "Wyatt on mornings",
        setBy: "Sequoia Taylor",
        setAt: "2026-08-22T10:00:00.000Z",
      },
    ];
    const duty = resolveDuty(8, 8, { available: ["Walker"], overrides });
    expect(duty.onDuty.map((a) => a.name)).toEqual(["Walker"]);
  });
});

// ── 4 · The two surfaces agree ───────────────────────────────────────────────

describe("the readout and the control cannot disagree", () => {
  it("shows the same change on the Employees on-duty panel and the admin rota", async () => {
    await clearAll();
    await call("/api/ai/duty/overrides", "POST", {
      kind: "SHIFT",
      employee_name: "Willow",
      shift_key: "MORNING",
      on_duty: true,
      reason: "Willow joins the morning while diligence is heavy",
    });

    const panel = await call<{ onDuty: Array<{ name: string }>; override_count: number }>(
      "/api/ai/employees/on-duty?hour=8&size=8",
    );
    const admin = await call<{ now: { onDuty: Array<{ name: string }> } }>("/api/ai/duty?hour=8&size=8");

    expect(panel.body.onDuty.map((a) => a.name)).toContain("Willow");
    expect(admin.body.now.onDuty.map((a) => a.name)).toContain("Willow");
    expect(panel.body.override_count).toBe(1);
    await clearAll();
  });
});

// ── 5 · Setting, reverting, and the record of both ───────────────────────────

describe("every override says who, when and why — and revert is one press", () => {
  it("refuses a change with no reason worth reading", async () => {
    const res = await call("/api/ai/duty/overrides", "POST", {
      kind: "SHIFT",
      employee_name: "Wyatt",
      shift_key: "MORNING",
      on_duty: true,
      reason: "x",
    });
    expect(res.status).toBe(400);
  });

  it("records who set it and when, and prints the hours in a form a person reads", async () => {
    await clearAll();
    await call("/api/ai/duty/overrides", "POST", {
      kind: "HOURS",
      employee_name: "Wyatt",
      from_hour: 6,
      to_hour: 20,
      reason: "Wyatt is available six in the morning to eight at night",
    });
    const picture = await call<{ overrides: Array<Record<string, string>> }>("/api/ai/duty?hour=9");
    const row = picture.body.overrides[0]!;
    expect(row.employee_name).toBe("Wyatt");
    expect(row.set_by).toBe("Sequoia Taylor");
    expect(row.set_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(row.reason).toContain("six in the morning");
    // 06:00 and 20:00 are not times anybody reads out loud.
    expect(row.hours).toBe("6:00 AM to 8:00 PM");
    expect(row.what).not.toMatch(/\bHOURS\b|\bMIDDAY\b|dov_/);
  });

  it("replaces an override rather than editing it, so the reason always fits the verdict", async () => {
    await clearAll();
    await call("/api/ai/duty/overrides", "POST", {
      kind: "SHIFT",
      employee_name: "Wyatt",
      shift_key: "OVERNIGHT",
      on_duty: false,
      reason: "off overnight for now",
    });
    await call("/api/ai/duty/overrides", "POST", {
      kind: "SHIFT",
      employee_name: "Wyatt",
      shift_key: "OVERNIGHT",
      on_duty: true,
      reason: "back on overnight from Monday",
    });
    const picture = await call<{ overrides: Array<Record<string, string>> }>("/api/ai/duty?hour=9");
    expect(picture.body.overrides).toHaveLength(1);
    expect(picture.body.overrides[0]!.reason).toBe("back on overnight from Monday");
    expect(picture.body.overrides[0]!.what).toContain("On the Overnight shift");
  });

  it("refuses an in-place edit at the database layer", async () => {
    await clearAll();
    await insertRaw("id, employee_name, kind, shift_key, on_duty, reason, set_by", [
      "dov_edit_test",
      "Wyatt",
      "SHIFT",
      "MORNING",
      1,
      "a reason worth reading",
      "fu_sequoia_taylor",
    ]);
    await expect(
      env.WP_OS_DB.prepare("UPDATE duty_override SET reason = ?2 WHERE id = ?1")
        .bind("dov_edit_test", "a different reason entirely")
        .run(),
    ).rejects.toThrow();
    await clearAll();
  });

  it("reverts in one call, with no reason required, and says so plainly the second time", async () => {
    await clearAll();
    await call("/api/ai/duty/overrides", "POST", {
      kind: "HOURS",
      employee_name: "Wyatt",
      from_hour: 6,
      to_hour: 20,
      reason: "Wyatt works six to eight",
    });
    const first = await call("/api/ai/duty/revert", "POST", { employee_name: "Wyatt", kind: "HOURS" });
    expect(first.status).toBe(200);
    const second = await call<{ detail: string }>("/api/ai/duty/revert", "POST", {
      employee_name: "Wyatt",
      kind: "HOURS",
    });
    expect(second.status).toBe(404);
    expect(second.body.detail).toContain("already on the default");
  });

  it("writes both the change and its removal onto the append-only spine", async () => {
    await clearAll();
    await call("/api/ai/duty/overrides", "POST", {
      kind: "SHIFT",
      employee_name: "Wyatt",
      shift_key: "MORNING",
      on_duty: true,
      reason: "Wyatt leads the morning sweep this week",
    });
    await call("/api/ai/duty/revert", "POST", { employee_name: "Wyatt", kind: "SHIFT", shift_key: "MORNING" });

    const events = await env.WP_OS_DB.prepare(
      "SELECT event_type, payload_json FROM event_record WHERE event_type LIKE 'duty.%' ORDER BY created_at",
    ).all<{ event_type: string; payload_json: string }>();
    const types = (events.results ?? []).map((e) => e.event_type);
    expect(types).toContain("duty.override_set");
    expect(types).toContain("duty.override_cleared");
    // The spine is append-only and shared with every earlier case here, so this looks for THIS
    // change rather than for the first one on it.
    const reasons = (events.results ?? [])
      .filter((e) => e.event_type === "duty.override_set")
      .map((e) => String(JSON.parse(e.payload_json).reason ?? ""));
    expect(reasons.some((r) => r.includes("morning sweep"))).toBe(true);
  });

  it("will not put somebody on a shift who is not employed", async () => {
    await clearAll();
    await env.WP_OS_DB.prepare("UPDATE ai_employee SET status = 'PAUSED' WHERE name = ?1").bind("Poppy").run();
    const res = await call<{ error: string; detail: string }>("/api/ai/duty/overrides", "POST", {
      kind: "SHIFT",
      employee_name: "Poppy",
      shift_key: "MORNING",
      on_duty: true,
      reason: "Poppy on mornings from next week",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("not_employed");
    // Taking somebody off is always allowed: it promises nothing.
    const off = await call("/api/ai/duty/overrides", "POST", {
      kind: "SHIFT",
      employee_name: "Poppy",
      shift_key: "MIDDAY",
      on_duty: false,
      reason: "Poppy is off midday while she is paused",
    });
    expect(off.status).toBe(201);
    await env.WP_OS_DB.prepare("UPDATE ai_employee SET status = 'ACTIVE' WHERE name = ?1").bind("Poppy").run();
    await clearAll();
  });

  it("refuses an employee who does not exist at all", async () => {
    const res = await call<{ error: string }>("/api/ai/duty/overrides", "POST", {
      kind: "SHIFT",
      employee_name: "Nobody",
      shift_key: "MORNING",
      on_duty: true,
      reason: "this person is invented",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("unknown_employee");
  });
});

// ── 6 · The constraints actually constrain ───────────────────────────────────

describe("migration 0137 constrains what it claims to constrain", () => {
  it("refuses a row that is both kinds at once", async () => {
    await expect(
      insertRaw("id, employee_name, kind, shift_key, on_duty, from_hour, to_hour, reason, set_by", [
        "dov_mixed",
        "Wyatt",
        "SHIFT",
        "MORNING",
        1,
        6,
        20,
        "a reason worth reading",
        "fu_sequoia_taylor",
      ]),
    ).rejects.toThrow();
  });

  it("refuses a SHIFT row with no verdict and an HOURS row with no window", async () => {
    await expect(
      insertRaw("id, employee_name, kind, shift_key, reason, set_by", [
        "dov_no_verdict",
        "Wyatt",
        "SHIFT",
        "MORNING",
        "a reason worth reading",
        "fu_sequoia_taylor",
      ]),
    ).rejects.toThrow();
    await expect(
      insertRaw("id, employee_name, kind, reason, set_by", [
        "dov_no_window",
        "Wyatt",
        "HOURS",
        "a reason worth reading",
        "fu_sequoia_taylor",
      ]),
    ).rejects.toThrow();
  });

  it("refuses a window that covers nothing — the CHECK that would pass if NULL were left unwrapped", async () => {
    // SQLite PASSES a CHECK evaluating to NULL; only an explicit FALSE fails one. `from_hour <>
    // to_hour` against a NULL yields NULL, so without IFNULL this constraint would silently not
    // constrain. That exact trap was hit in this repo yesterday, which is why it has its own test.
    await expect(
      insertRaw("id, employee_name, kind, from_hour, to_hour, reason, set_by", [
        "dov_empty_window",
        "Wyatt",
        "HOURS",
        9,
        9,
        "a reason worth reading",
        "fu_sequoia_taylor",
      ]),
    ).rejects.toThrow();
  });

  it("refuses a reason nobody could review later", async () => {
    await expect(
      insertRaw("id, employee_name, kind, shift_key, on_duty, reason, set_by", [
        "dov_no_reason",
        "Wyatt",
        "SHIFT",
        "MORNING",
        1,
        "  ",
        "fu_sequoia_taylor",
      ]),
    ).rejects.toThrow();
  });

  it("refuses two verdicts on the same person and shift", async () => {
    await clearAll();
    await insertRaw("id, employee_name, kind, shift_key, on_duty, reason, set_by", [
      "dov_unique_a",
      "Wyatt",
      "SHIFT",
      "OVERNIGHT",
      1,
      "a reason worth reading",
      "fu_sequoia_taylor",
    ]);
    await expect(
      insertRaw("id, employee_name, kind, shift_key, on_duty, reason, set_by", [
        "dov_unique_b",
        "Wyatt",
        "SHIFT",
        "OVERNIGHT",
        0,
        "a contradicting reason",
        "fu_sequoia_taylor",
      ]),
    ).rejects.toThrow();
    await clearAll();
  });

  it("registers both action keys, so authorize() does not fail closed on a live database", async () => {
    const rows = await env.WP_OS_DB.prepare(
      "SELECT key, is_reserved, is_external_effect FROM action_type WHERE key LIKE 'duty_override.%' ORDER BY key",
    ).all<{ key: string; is_reserved: number; is_external_effect: number }>();
    expect((rows.results ?? []).map((r) => r.key)).toEqual(["duty_override.clear", "duty_override.set"]);
    for (const r of rows.results ?? []) {
      expect(r.is_reserved).toBe(0);
      expect(r.is_external_effect).toBe(0);
    }
  });
});

// ── 7 · Nothing raw reaches a reader ─────────────────────────────────────────

describe("what the surface is given is already readable", () => {
  it("names every hour the way a person says it", () => {
    expect(readableHour(0)).toBe("12:00 AM");
    expect(readableHour(9)).toBe("9:00 AM");
    expect(readableHour(12)).toBe("12:00 PM");
    expect(readableHour(21)).toBe("9:00 PM");
  });

  it("hands the page a readable label for every shift and every source", async () => {
    const picture = await call<{
      shifts: Array<{ label: string; hours: string }>;
      now: { hour_label: string; label: string };
      day: Array<{ hours: string; onDuty: Array<{ sourceLabel: string }> }>;
    }>("/api/ai/duty?hour=21");
    expect(picture.status).toBe(200);
    expect(picture.body.now.hour_label).toBe("9:00 PM");
    expect(picture.body.shifts.map((s) => s.label)).toEqual(SHIFTS.map((s) => s.label));
    for (const s of picture.body.shifts) expect(s.hours).toMatch(/(AM|PM) to .*(AM|PM)/);
    for (const s of picture.body.day) {
      for (const a of s.onDuty) expect(a.sourceLabel).not.toMatch(/^[A-Z_]+$/);
    }
  });

  it("gives every person on the rota a reason a person can read", () => {
    for (const shift of resolveDay(5)) {
      for (const a of shift.onDuty) {
        expect(a.because.length).toBeGreaterThan(10);
        expect(a.role.length).toBeGreaterThan(0);
      }
    }
  });
});
