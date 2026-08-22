import { z } from "zod";
import type { RouteContext } from "../router";
import { json } from "../router";
import { actorFromIdentity, authorize } from "./authorize";
import { appendEvent } from "../events";
import type { Env } from "../env";
import {
  DUTY_PRECEDENCE,
  DUTY_SOURCE_LABEL,
  SHIFTS,
  readableHour,
  readableWindow,
  resolveDay,
  resolveDuty,
  type DutyOverride,
  type ShiftKey,
} from "../../shared/workforce/dutyRoster";

/**
 * The operator's changes to the duty roster — and only the changes.
 *
 * Operator, 22 Aug 2026: "what is dutyroster's flow? i want a default flow and one that i can
 * change in the admin section ---i should be able to adj hours for an employee"
 *
 * WHERE THE THINKING LIVES. `src/shared/workforce/dutyRoster.ts` — its docstring explains why the
 * rota is deterministic rather than model-decided, why the code default stays the fallback, and
 * what `DUTY_PRECEDENCE` means. This file does the two things that module deliberately cannot: it
 * reads rows, and it writes them. It never decides anything about the rota; it hands the overrides
 * to `resolveDuty` and prints what comes back.
 *
 * That split is not tidiness. The resolver stays pure BECAUSE it is fed rather than reaching for a
 * database, and its purity is the reason a partner can predict the rota — which is the property the
 * module says a rota must not lose.
 */

const SHIFT_KEYS = SHIFTS.map((s) => s.key) as unknown as [ShiftKey, ...ShiftKey[]];

interface OverrideRow {
  id: string;
  employee_name: string;
  kind: "SHIFT" | "HOURS";
  shift_key: ShiftKey | null;
  on_duty: number | null;
  from_hour: number | null;
  to_hour: number | null;
  reason: string;
  created_at: string;
  set_by_name: string | null;
}

/**
 * Every stored difference, as the pure module wants them.
 *
 * `set_by` becomes a NAME here rather than travelling as a `fu_…` id: an id on a screen is not an
 * answer to "who changed this", and the translation belongs at the edge that knows about rows.
 */
export async function loadDutyOverrides(env: Env): Promise<{ rows: OverrideRow[]; overrides: DutyOverride[] }> {
  const res = await env.WP_OS_DB.prepare(
    `SELECT d.id, d.employee_name, d.kind, d.shift_key, d.on_duty, d.from_hour, d.to_hour,
            d.reason, d.created_at, fu.full_name AS set_by_name
       FROM duty_override d
       LEFT JOIN firm_user fu ON fu.id = d.set_by
      WHERE d.firm_scope = ?1
      ORDER BY d.created_at DESC`,
  )
    .bind("west-peek")
    .all<OverrideRow>();

  const rows = res.results ?? [];
  const overrides: DutyOverride[] = rows.map((r) => ({
    name: r.employee_name,
    kind: r.kind,
    shift: r.shift_key ?? undefined,
    onDuty: r.on_duty === null ? undefined : r.on_duty === 1,
    fromHour: r.from_hour ?? undefined,
    toHour: r.to_hour ?? undefined,
    reason: r.reason,
    setBy: r.set_by_name ?? "a partner",
    setAt: r.created_at,
  }));
  return { rows, overrides };
}

/** One override, in the words the page prints. No key, no id, no 24-hour clock. */
function describe(r: OverrideRow): Record<string, unknown> {
  const shift = r.shift_key ? SHIFTS.find((s) => s.key === r.shift_key) : null;
  return {
    employee_name: r.employee_name,
    kind: r.kind,
    // The natural key the revert button sends back. Deliberately not the row id — reverting is a
    // statement about a person and a shift, and the reader never needs to see a primary key.
    shift_key: r.shift_key,
    what:
      r.kind === "HOURS"
        ? `Works ${readableWindow(r.from_hour ?? 0, r.to_hour ?? 0)}, whatever the shifts say`
        : r.on_duty === 1
          ? `On the ${shift?.label ?? "shift"} shift`
          : `Off the ${shift?.label ?? "shift"} shift`,
    shift_label: shift?.label ?? null,
    hours: r.kind === "HOURS" ? readableWindow(r.from_hour ?? 0, r.to_hour ?? 0) : null,
    reason: r.reason,
    set_by: r.set_by_name ?? "a partner",
    set_at: r.created_at,
  };
}

/** The hour the caller means. A Worker runs in UTC and the partner does not. */
function hourFrom(request: Request): { hour: number; fromCaller: boolean } {
  const raw = new URL(request.url).searchParams.get("hour");
  const n = raw === null ? null : Number(raw);
  if (n === null || !Number.isFinite(n)) return { hour: new Date().getUTCHours(), fromCaller: false };
  return { hour: Math.trunc(n), fromCaller: true };
}

async function activeNames(env: Env): Promise<{ available: string[]; total: number }> {
  const rows = await env.WP_OS_DB.prepare("SELECT name, status FROM ai_employee WHERE firm_scope = ?1")
    .bind("west-peek")
    .all<{ name: string; status: string }>();
  const all = rows.results ?? [];
  return { available: all.filter((r) => r.status === "ACTIVE").map((r) => r.name), total: all.length };
}

const FOCUS_TEAM_SIZE = 5;

/**
 * The whole picture the admin surface needs in one call: now, the day, and what was changed.
 *
 * One request rather than three, because the three answers must agree. Fetching "who is on now" and
 * "the day's rota" separately would let them be computed from different override sets a second
 * apart, and a rota that disagrees with itself is the exact failure this feature exists to prevent.
 */
export async function handleDutyPicture(ctx: RouteContext): Promise<Response> {
  const { hour, fromCaller } = hourFrom(ctx.request);
  const size = Number(new URL(ctx.request.url).searchParams.get("size") ?? FOCUS_TEAM_SIZE) || FOCUS_TEAM_SIZE;

  const [{ available, total }, { rows, overrides }] = await Promise.all([
    activeNames(ctx.env),
    loadDutyOverrides(ctx.env),
  ]);

  const now = resolveDuty(hour, size, { available, overrides });
  const day = resolveDay(size, { available, overrides });

  return json({
    now: { ...now, hour_label: readableHour(hour), hour_source: fromCaller ? "caller" : "utc" },
    day,
    overrides: rows.map(describe),
    shifts: SHIFTS.map((s) => ({ key: s.key, label: s.label, hours: readableWindow(s.from, s.to), intent: s.intent })),
    /** Who may be named in a change. Only people who are actually employed. */
    employees: available.slice().sort(),
    active_count: available.length,
    roster_size: total,
    /**
     * The rule, in one sentence, taken from the one place it is declared rather than retyped here.
     * A page that explains precedence in its own words is a second statement of it.
     */
    precedence: DUTY_PRECEDENCE.map((s) => DUTY_SOURCE_LABEL[s]),
    how_it_works:
      "The firm's default rota is written into the system and never changes on its own. Anything you " +
      "set below is stored as a difference from that default, so putting it back to default removes " +
      "the difference rather than remembering an old value.",
  });
}

/**
 * Setting one difference.
 *
 * Two kinds and no third. The shape is checked here before authorize() rather than after, because
 * "you sent something the rota cannot mean" is not an authority question.
 */
const setSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("SHIFT"),
    employee_name: z.string().trim().min(1),
    shift_key: z.enum(SHIFT_KEYS),
    on_duty: z.boolean(),
    reason: z.string().trim().min(4),
  }),
  z.object({
    kind: z.literal("HOURS"),
    employee_name: z.string().trim().min(1),
    from_hour: z.number().int().min(0).max(23),
    to_hour: z.number().int().min(0).max(23),
    reason: z.string().trim().min(4),
  }),
]);

export async function handleSetDutyOverride(ctx: RouteContext): Promise<Response> {
  const parsed = setSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!parsed.success) {
    return json(
      { error: "invalid_input", detail: "Say who, what changes, and why — a reason of at least four characters." },
      { status: 400 },
    );
  }
  const input = parsed.data;

  const actor = actorFromIdentity(ctx.identity!);
  /*
   * HUMAN ONLY, and this is the line that keeps the module docstring true. "Who should be on duty
   * at 2pm" is a mapping the operator must be able to predict, disagree with and change — an AI
   * employee rewriting the rota, including its own place on it, would make it exactly as
   * unpredictable and unarguable as asking a model in the first place.
   */
  if (actor.type !== "HUMAN") {
    return json(
      { error: "human_required", detail: "The rota is the firm's, not an employee's. A person changes it." },
      { status: 403 },
    );
  }

  const authz = await authorize(ctx.env, actor, "duty_override.set", {
    objectType: "duty_override",
    objectId: input.employee_name,
  });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });

  const employee = await ctx.env.WP_OS_DB.prepare(
    "SELECT name, status FROM ai_employee WHERE name = ?1 AND firm_scope = ?2",
  )
    .bind(input.employee_name, "west-peek")
    .first<{ name: string; status: string }>();
  if (!employee) {
    return json({ error: "unknown_employee", detail: `Nobody here is called ${input.employee_name}.` }, { status: 400 });
  }

  /*
   * A ROTA CANNOT EMPLOY ANYBODY. The duty roster decides who the firm leans on at an hour; whether
   * a seat exists and may be given work is a separate decision on the reserved activation path
   * (D10). Refusing here rather than silently writing a row that `resolveDuty` will drop keeps the
   * operator from believing she has arranged cover that will never arrive.
   */
  if (employee.status !== "ACTIVE" && !(input.kind === "SHIFT" && input.on_duty === false)) {
    return json(
      {
        error: "not_employed",
        detail: `${employee.name} is not switched on, so putting them on a shift would promise help that never arrives. Employ them first.`,
      },
      { status: 400 },
    );
  }

  if (input.kind === "HOURS" && input.from_hour === input.to_hour) {
    return json(
      {
        error: "empty_window",
        detail:
          "Hours that start and end at the same time cover nothing. To take somebody off the rota, turn them off each shift instead.",
      },
      { status: 400 },
    );
  }

  const id = `dov_${crypto.randomUUID()}`;
  const db = ctx.env.WP_OS_DB;

  /*
   * REPLACE, NOT UPDATE. The table refuses an UPDATE by trigger: every column in a row is part of
   * one statement — this person, this shift, this reason, this partner, this moment — and editing
   * any of it would leave today's reason attached to yesterday's decision. So a re-set is a delete
   * and an insert, and the reason always describes the verdict standing beside it.
   *
   * Deliberately NOT `INSERT OR REPLACE`/`INSERT OR IGNORE`: both swallow a CHECK failure silently,
   * which has shipped that bug here twice. A plain INSERT after a plain DELETE fails loudly.
   */
  const clearOld =
    input.kind === "HOURS"
      ? db.prepare("DELETE FROM duty_override WHERE employee_name = ?1 AND kind = 'HOURS'").bind(input.employee_name)
      : db
          .prepare("DELETE FROM duty_override WHERE employee_name = ?1 AND kind = 'SHIFT' AND shift_key = ?2")
          .bind(input.employee_name, input.shift_key);

  const insert =
    input.kind === "HOURS"
      ? db
          .prepare(
            `INSERT INTO duty_override (id, employee_name, kind, from_hour, to_hour, reason, set_by)
             VALUES (?1, ?2, 'HOURS', ?3, ?4, ?5, ?6)`,
          )
          .bind(id, input.employee_name, input.from_hour, input.to_hour, input.reason, ctx.identity!.id)
      : db
          .prepare(
            `INSERT INTO duty_override (id, employee_name, kind, shift_key, on_duty, reason, set_by)
             VALUES (?1, ?2, 'SHIFT', ?3, ?4, ?5, ?6)`,
          )
          .bind(id, input.employee_name, input.shift_key, input.on_duty ? 1 : 0, input.reason, ctx.identity!.id);

  await db.batch([clearOld, insert]);

  await appendEvent(ctx.env, {
    eventType: "duty.override_set",
    actorType: "firm_user",
    actorId: ctx.identity!.id,
    objectType: "duty_override",
    objectId: id,
    payload:
      input.kind === "HOURS"
        ? {
            employee_name: input.employee_name,
            kind: "HOURS",
            hours: readableWindow(input.from_hour, input.to_hour),
            from_hour: input.from_hour,
            to_hour: input.to_hour,
            reason: input.reason,
          }
        : {
            employee_name: input.employee_name,
            kind: "SHIFT",
            shift_key: input.shift_key,
            on_duty: input.on_duty,
            reason: input.reason,
          },
  });

  return json({ ok: true, employee_name: input.employee_name }, { status: 201 });
}

/**
 * Putting one thing back to default.
 *
 * BY NATURAL KEY, not by row id. Reverting is a statement about a person and a shift — "Wyatt goes
 * back to whatever the firm does on Overnight" — and a screen that has to show a `dov_…` to offer
 * the button has already failed the rule that no raw id reaches a reader.
 *
 * No reason is required. The same rule that already governs revoking a standing grant and pausing
 * an employee: a control that returns the system to the default everything else already agrees on
 * should never be harder to reach than the one that moved it away. What was removed, by whom, and
 * when is still on the spine.
 */
const revertSchema = z.object({
  employee_name: z.string().trim().min(1),
  kind: z.enum(["SHIFT", "HOURS"]),
  shift_key: z.enum(SHIFT_KEYS).optional(),
});

export async function handleRevertDutyOverride(ctx: RouteContext): Promise<Response> {
  const parsed = revertSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_input", detail: "Say which change to undo." }, { status: 400 });
  const input = parsed.data;
  if (input.kind === "SHIFT" && !input.shift_key) {
    return json({ error: "invalid_input", detail: "Say which shift goes back to default." }, { status: 400 });
  }

  const actor = actorFromIdentity(ctx.identity!);
  if (actor.type !== "HUMAN") {
    return json(
      { error: "human_required", detail: "The rota is the firm's, not an employee's. A person changes it." },
      { status: 403 },
    );
  }

  const authz = await authorize(ctx.env, actor, "duty_override.clear", {
    objectType: "duty_override",
    objectId: input.employee_name,
  });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });

  const res =
    input.kind === "HOURS"
      ? await ctx.env.WP_OS_DB.prepare(
          "DELETE FROM duty_override WHERE employee_name = ?1 AND kind = 'HOURS' AND firm_scope = ?2",
        )
          .bind(input.employee_name, "west-peek")
          .run()
      : await ctx.env.WP_OS_DB.prepare(
          "DELETE FROM duty_override WHERE employee_name = ?1 AND kind = 'SHIFT' AND shift_key = ?2 AND firm_scope = ?3",
        )
          .bind(input.employee_name, input.shift_key, "west-peek")
          .run();

  if ((res.meta?.changes ?? 0) === 0) {
    return json({ error: "not_found", detail: "That was already on the default." }, { status: 404 });
  }

  await appendEvent(ctx.env, {
    eventType: "duty.override_cleared",
    actorType: "firm_user",
    actorId: ctx.identity!.id,
    objectType: "duty_override",
    objectId: input.employee_name,
    payload: { employee_name: input.employee_name, kind: input.kind, shift_key: input.shift_key ?? null },
  });

  return json({ ok: true });
}
