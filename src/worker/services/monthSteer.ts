import type { Env } from "../env";
import type { Actor } from "./authorize";
import { authorize } from "./authorize";
import { appendEvent } from "../events";
import { dueOn, planFor, steerLines, type Stream } from "../../shared/events/monthlyPlan";

/**
 * A STEER — words she gives now, FOR a month Parker has not built yet (18 Sep 2026).
 *
 * ─── Her words ─────────────────────────────────────────────────────────────────────────────────
 *
 *   "if i make an ask of Parker for next month's proposal or ask for a one-off that is 2 diff
 *    things: a one off should be delivered and acted upon immediately; asking for a specific topic
 *    or angle to next months propoals should come when the month's proposal comes"
 *
 * ─── What this file is, and what it deliberately is not ───────────────────────────────────────
 *
 * It is the RUNTIME half of `MONTHLY_PLAN`. The plan stays in code because it is a decision the
 * partners made once and should read in a diff; this is the half she writes from the page between
 * those decisions, and the two meet in exactly one place — `steerLines` — so there is one statement
 * of "what Parker has been told about this month" rather than two lists that drift.
 *
 * IT IS NOT A CLASSIFIER. Nothing here reads her prose to decide what she meant. Which kind of ask
 * this was is DECLARED at the door (`classifyAsk`), and what arrives here is already known to be a
 * steer. See migration 0194 for why a model or a regex guessing that was refused.
 *
 * ─── The three things a steer has to do, and where each one is ────────────────────────────────
 *
 *   RECORDED AGAINST THE MONTH IT IS FOR   `for_month`, not the month it arrived in (`given_at`).
 *   SURVIVES UNTIL THAT MONTH IS BUILT     `liveSteers` is read when the packet decides its topic,
 *                                          which is the one moment the words can still change the
 *                                          output — and `markDelivered` records which packet took
 *                                          them, so a steer is not remembered for ever.
 *   VISIBLE IN THE MEANTIME                `steerBoard` feeds the Rooms page. An instruction given
 *                                          in September that is invisible until October is an
 *                                          instruction she cannot correct, and correcting it is the
 *                                          whole reason for showing it.
 */

export interface MonthSteerRow {
  id: string;
  firm_scope: string;
  for_month: string;
  stream: Stream;
  words: string;
  given_by: string | null;
  given_at: string;
  withdrawn_at: string | null;
  withdrawn_by: string | null;
  delivered_packet_id: string | null;
  delivered_at: string | null;
}

export class MonthSteerError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

/**
 * Write one down.
 *
 * The same authority as asking for a Room: `room_packet.manage`. A steer changes what Parker builds
 * next month as surely as a brief changes what he builds today, so it cannot be the cheaper gate.
 */
export async function recordSteer(
  env: Env,
  actor: Actor,
  input: { month: string; stream: Stream; words: string },
): Promise<MonthSteerRow> {
  const firmScope = actor.firmScopes[0] ?? "west-peek";
  const authz = await authorize(env, actor, "room_packet.manage", { objectType: "room_packet", firmScope });
  if (authz.decision !== "ALLOW") throw new MonthSteerError(403, "forbidden", authz.reason);

  const words = input.words.trim();
  if (words.length < 3) throw new MonthSteerError(400, "invalid_input", "a steer needs some words");
  if (!/^\d{4}-\d{2}$/.test(input.month)) throw new MonthSteerError(400, "invalid_input", "a steer needs the month it is for");

  const id = `mst_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    `INSERT INTO evt_month_steer (id, firm_scope, for_month, stream, words, given_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  ).bind(id, firmScope, input.month, input.stream, words.slice(0, 2000), actor.firmUserId ?? actor.aiEmployeeId ?? null).run();

  await appendEvent(env, {
    eventType: "room_packet.steered",
    actorType: actor.type === "HUMAN" ? "firm_user" : "ai_employee",
    actorId: actor.firmUserId ?? actor.aiEmployeeId ?? "system",
    objectType: "month_steer",
    objectId: id,
    firmScope,
    // The words themselves are on the row; the event records that a month's instruction changed.
    payload: { for_month: input.month, stream: input.stream, chars: words.length, due: dueOn(input.month) },
  });
  return await requireSteer(env, id);
}

export async function requireSteer(env: Env, id: string): Promise<MonthSteerRow> {
  const row = await env.WP_OS_DB.prepare("SELECT * FROM evt_month_steer WHERE id = ?1").bind(id).first<MonthSteerRow>();
  if (!row) throw new MonthSteerError(404, "not_found", "no such steer");
  return row;
}

/**
 * She changed her mind. A withdrawal is EXPLICIT and it is a column, not a delete: what she told
 * Parker in September is part of the record of why November looks the way it does, and a row that
 * vanishes takes that with it.
 */
export async function withdrawSteer(env: Env, actor: Actor, id: string): Promise<MonthSteerRow> {
  const firmScope = actor.firmScopes[0] ?? "west-peek";
  const authz = await authorize(env, actor, "room_packet.manage", { objectType: "room_packet", firmScope });
  if (authz.decision !== "ALLOW") throw new MonthSteerError(403, "forbidden", authz.reason);
  const row = await requireSteer(env, id);
  if (row.withdrawn_at) return row;
  await env.WP_OS_DB.prepare(
    `UPDATE evt_month_steer
        SET withdrawn_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), withdrawn_by = ?2
      WHERE id = ?1`,
  ).bind(id, actor.firmUserId ?? "system").run();
  await appendEvent(env, {
    eventType: "room_packet.steer_withdrawn",
    actorType: actor.type === "HUMAN" ? "firm_user" : "ai_employee",
    actorId: actor.firmUserId ?? actor.aiEmployeeId ?? "system",
    objectType: "month_steer", objectId: id, firmScope,
    payload: { for_month: row.for_month, stream: row.stream, was_delivered: Boolean(row.delivered_packet_id) },
  });
  return await requireSteer(env, id);
}

/**
 * The steers that still have to reach a packet for this month and stream, oldest first.
 *
 * Oldest first is not cosmetic — it is what makes "a later instruction outranks an earlier one"
 * mean something when she has given two.
 */
export async function liveSteers(env: Env, firmScope: string, month: string, stream: Stream): Promise<MonthSteerRow[]> {
  const rows = await env.WP_OS_DB.prepare(
    `SELECT * FROM evt_month_steer
      WHERE firm_scope = ?1 AND for_month = ?2 AND stream = ?3 AND withdrawn_at IS NULL
      ORDER BY given_at ASC, id ASC`,
  ).bind(firmScope, month, stream).all<MonthSteerRow>();
  return rows.results ?? [];
}

/**
 * EVERYTHING PARKER HAS BEEN TOLD ABOUT THIS MONTH AND STREAM, in the one string the prompts take.
 *
 * "A steer that has to be remembered at each stage is a steer that will be forgotten at one of
 * them." So both streams call THIS, once, at the moment their topic is settled — and
 * `validate:steer-waits` fails if either of them builds its concepts prompt from a bare plan steer
 * instead. The plan's own steer comes first because it is the standing decision; hers come after
 * because they are the more recent word.
 */
export async function steerForMonth(
  env: Env,
  firmScope: string,
  month: string,
  stream: Stream,
  planSteer?: string | null,
): Promise<{ text: string | null; rows: MonthSteerRow[] }> {
  const rows = await liveSteers(env, firmScope, month, stream);
  const fromPlan = planSteer !== undefined ? planSteer : (planFor(month, stream)?.steer ?? null);
  return { text: steerLines(fromPlan ?? null, rows.map((r) => r.words)), rows };
}

/**
 * The words reached the packet. Recorded at the moment they are put INTO the prompt rather than
 * when the packet lands, because that is the moment it is true — and a steer marked delivered by a
 * build that then failed would be a steer silently dropped.
 */
export async function markDelivered(env: Env, rows: readonly MonthSteerRow[], packetId: string): Promise<void> {
  const pending = rows.filter((r) => !r.delivered_packet_id);
  if (pending.length === 0) return;
  await env.WP_OS_DB.batch(
    pending.map((r) =>
      env.WP_OS_DB.prepare(
        `UPDATE evt_month_steer
            SET delivered_packet_id = ?2, delivered_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ?1 AND delivered_packet_id IS NULL`,
      ).bind(r.id, packetId),
    ),
  );
}

/**
 * What the page shows: everything still owed, and what has already gone in, newest month first.
 * Sixty rows is the same ceiling the packet list uses — this is a board, not an archive.
 */
export async function steerBoard(env: Env, firmScope: string): Promise<MonthSteerRow[]> {
  const rows = await env.WP_OS_DB.prepare(
    `SELECT * FROM evt_month_steer
      WHERE firm_scope = ?1
      ORDER BY for_month DESC, given_at ASC LIMIT 60`,
  ).bind(firmScope).all<MonthSteerRow>();
  return rows.results ?? [];
}
