import type { Env } from "../env";
import type { Actor } from "./authorize";
import { appendEvent } from "../events";
import { runAi } from "../ai/runAi";
import { isSeatWait } from "../../shared/ai/seatOrder";

/*
 * DRIFT PREVENTION (owner, 13 Nov 2026). Each deliverable's floor writes what it measured for every run, in the
 * event log that already exists (`floor.measured`; no new table). One section of Wynn's Monday roundup, the weekly
 * email Sequoia already gets, reads those rows back: this week against the best past run and the last four weeks,
 * flagged only on a floor miss or two weeks running more than 25% below the best. A deliverable nothing measured
 * says "not measured"; it is never left out. Once a month her Claude seat (Codex as its backup, never a free or
 * paid route) reads the latest real output of each against its best example and adds a short section.
 */
export const DELIVERABLES = {
  hire_search: { label: "Weekly hire search (Productions)", unit: "people at the floor", agg: "last" },
  productions_monthly: { label: "Productions monthly note", unit: "customer leads", agg: "last" },
  room_sponsors: { label: "Room sponsor research", unit: "sponsors with a contact or a page", agg: "last" },
  room_packet: { label: "Room packet proposal", unit: "written with nothing to caveat (1 yes, 0 no)", agg: "last" },
  tlc_brand_batch: { label: "TLC brand batch", unit: "new brands found", agg: "last" },
  wednesday_prep: { label: "Wednesday prep", unit: "% of meetings with a reason", agg: "mean" },
} as const;
export type Deliverable = keyof typeof DELIVERABLES;
export const DRIFT_BELOW_BEST = 0.25;

export interface FloorRun {
  deliverable: Deliverable;
  ok: boolean;
  /** The one number the drift line follows. */
  headline: number;
  measures: Record<string, number>;
  aiRunId?: string | null;
  /** The start of the real output, kept for the monthly read. */
  sample?: string | null;
  firmScope?: string;
  /** When the run happened; now unless a caller (or a test) says otherwise. The event log's own time cannot be set. */
  at?: Date;
}

/** Write one run's measures. A failure to measure never fails the work; the drift line then says "not measured". */
export async function recordFloor(env: Env, run: FloorRun): Promise<void> {
  try {
    const route = run.aiRunId ? (await env.WP_OS_DB.prepare("SELECT model FROM ai_run WHERE id = ?1").bind(run.aiRunId).first<{ model: string | null }>())?.model ?? null : null;
    await appendEvent(env, {
      eventType: "floor.measured",
      actorType: "system",
      actorId: "floor",
      objectType: "floor",
      objectId: run.deliverable,
      firmScope: run.firmScope ?? "west-peek",
      payload: { at: (run.at ?? new Date()).toISOString(), ok: run.ok, headline: run.headline, measures: run.measures, route, sample: run.sample ? run.sample.slice(0, 2500) : null },
    });
  } catch (err) {
    console.error(`floor.measured could not be written for ${run.deliverable}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface WeekPoint { week: string; headline: number; ok: boolean }

/**
 * One deliverable's line. Pure. `points` is one per measured week, any order; a week is the seven days ending on the
 * date that names it (the roundup goes on Monday morning, before most of that calendar week's work has run).
 */
export function driftLine(label: string, unit: string, points: readonly WeekPoint[], thisWeek: string): { line: string; flagged: boolean } {
  const sorted = [...points].sort((a, b) => a.week.localeCompare(b.week));
  const cur = sorted.find((p) => p.week === thisWeek);
  const past = sorted.filter((p) => p.week < thisWeek);
  const last = past[past.length - 1];
  if (!cur) return { line: last ? `${label}: not measured in the last 7 days (last: ${unit.startsWith("%") ? `${last.headline}${unit}` : `${last.headline} ${unit}`}, week to ${last.week}).` : `${label}: not measured yet, no run since measuring began (13 Nov 2026).`, flagged: false };
  const best = past.reduce<WeekPoint | null>((b, p) => (!b || p.headline > b.headline ? p : b), null);
  const trend = [...past.slice(-3), cur].map((p) => p.headline).join(", ");
  const n = (v: number): string => (unit.startsWith("%") ? `${v}${unit}` : `${v} ${unit}`);
  const below = (p: WeekPoint | undefined): boolean => Boolean(p && best && best.headline > 0 && p.headline < best.headline * (1 - DRIFT_BELOW_BEST));
  const drifting = below(cur) && below(last);
  const flag = !cur.ok ? " BELOW ITS FLOOR." : drifting ? ` DRIFTING: more than ${DRIFT_BELOW_BEST * 100}% below its best two weeks running.` : "";
  return {
    line: `${label}: ${n(cur.headline)} in the last 7 days; ${best ? `best ${best.headline} (week to ${best.week}); last ${Math.min(4, past.length + 1)} measured: ${trend}` : "the first measured week"}.${flag}`,
    flagged: flag !== "",
  };
}

interface FloorEvent { object_id: string; created_at: string; payload_json: string }
async function floorEvents(env: Env, firmScope: string, sinceIso: string): Promise<FloorEvent[]> {
  return (await env.WP_OS_DB.prepare(
    "SELECT object_id, created_at, payload_json FROM event_record WHERE event_type = 'floor.measured' AND firm_scope = ?1 AND created_at >= ?2 ORDER BY created_at",
  ).bind(firmScope, sinceIso).all<FloorEvent>()).results ?? [];
}

/** The roundup's section: one row per deliverable, every week, measured or not. */
export async function driftSection(env: Env, now: Date, firmScope = "west-peek"): Promise<{ label: string; bullets: string[]; flagged: number }> {
  const events = await floorEvents(env, firmScope, new Date(now.getTime() - 400 * 86_400_000).toISOString());
  // Seven-day weeks ending now, each named by the date it ends on.
  const weekOf = (iso: string): string => new Date(now.getTime() - Math.floor((now.getTime() - Date.parse(iso)) / (7 * 86_400_000)) * 7 * 86_400_000).toISOString().slice(0, 10);
  const thisWeek = now.toISOString().slice(0, 10);
  let flagged = 0;
  let measured = 0;
  const bullets = (Object.keys(DELIVERABLES) as Deliverable[]).map((key) => {
    const d = DELIVERABLES[key];
    const byWeek = new Map<string, Array<{ headline: number; ok: boolean }>>();
    for (const e of events.filter((x) => x.object_id === key)) {
      const p = JSON.parse(e.payload_json) as { at?: string; headline?: number; ok?: boolean };
      const week = weekOf(p.at ?? e.created_at);
      byWeek.set(week, [...(byWeek.get(week) ?? []), { headline: Number(p.headline ?? 0), ok: p.ok !== false }]);
    }
    const points: WeekPoint[] = [...byWeek].map(([week, runs]) =>
      d.agg === "mean"
        ? { week, headline: Math.round((runs.reduce((n, r) => n + r.headline, 0) / runs.length) * 100), ok: runs.some((r) => r.ok) }
        : { week, headline: runs[runs.length - 1]!.headline, ok: runs[runs.length - 1]!.ok },
    );
    const out = driftLine(d.label, d.unit, points, thisWeek);
    if (out.flagged) flagged += 1;
    if (byWeek.has(thisWeek)) measured += 1;
    return out.line;
  });
  return { label: `Quality of the work: ${flagged ? `${flagged} to look at` : measured ? "nothing flagged" : "nothing was measured in the last 7 days"}`, bullets, flagged };
}

export type SeatReader = (env: Env, prompt: string, firmScope: string) => Promise<{ ok: boolean; text: string; detail: string }>;
const seatReader: SeatReader = async (env, prompt, firmScope) => {
  const actor: Actor = { type: "AI", aiEmployeeId: "aie_wynn", roles: [], firmScopes: [firmScope] };
  const { run } = await runAi(env, {
    purpose: "the monthly read of each deliverable against its best example",
    actor,
    inputs: [prompt],
    sensitivity: "INTERNAL" as never,
    // Real output, so private: her Claude seat, Codex as its backup, never a free lane; and never a paid one.
    budgetContext: { judgement: true, confidential: true, seatFirst: true, neverPaid: true, expectedOutputTokens: 600 },
    routing: { category: "OPERATIONS" },
  });
  return run.status === "COMPLETED" && run.output_text ? { ok: true, text: run.output_text, detail: "ok" } : { ok: false, text: "", detail: run.failure_reason ?? `run ${run.status}` };
};

/**
 * THE MONTHLY READ. Once a calendar month: the latest real output of each deliverable beside its best measured
 * example, read on a seat. Null when this month's read already happened or there is nothing to compare yet; a read that could not happen says why and
 * is tried again with the next roundup (a named stop, never a silent skip).
 */
export async function monthlyRead(env: Env, now: Date, firmScope = "west-peek", read: SeatReader = seatReader): Promise<{ label: string; bullets: string[]; done: boolean } | null> {
  const month = now.toISOString().slice(0, 7);
  const done = await env.WP_OS_DB.prepare("SELECT 1 AS x FROM event_record WHERE event_type = 'floor.monthly_read' AND object_id = ?1 AND firm_scope = ?2").bind(month, firmScope).first<{ x: number }>();
  if (done) return null;
  const label = `The monthly read (${month}): the latest of each against its best`;
  const events = await floorEvents(env, firmScope, new Date(now.getTime() - 400 * 86_400_000).toISOString());
  const pairs = (Object.keys(DELIVERABLES) as Deliverable[]).flatMap((key) => {
    const runs = events.filter((e) => e.object_id === key).map((e) => JSON.parse(e.payload_json) as { headline?: number; ok?: boolean; sample?: string | null }).filter((p) => p.sample);
    const latest = runs[runs.length - 1];
    const best = runs.slice(0, -1).filter((p) => p.ok !== false).reduce<(typeof runs)[number] | null>((b, p) => (!b || Number(p.headline ?? 0) > Number(b.headline ?? 0) ? p : b), null);
    return latest && best ? [{ key, latest: latest.sample!, best: best.sample! }] : [];
  });
  // Nothing to compare yet (the rows above already say what has not been measured): no section, and it stays owed.
  if (pairs.length === 0) return null;
  const prompt = [
    "For each deliverable below, compare the LATEST output with the BEST EXAMPLE. Answer with ONE line per deliverable and nothing else:",
    "<deliverable name>: BETTER, SAME or WORSE than its best, then the one concrete reason in under 25 words.",
    "Judge the substance (specific, sourced, usable), not the length or the tone.",
    ...pairs.map((p) => `\n=== ${DELIVERABLES[p.key].label} ===\nBEST EXAMPLE:\n${p.best}\n\nLATEST:\n${p.latest}`),
  ].join("\n");
  const out = await read(env, prompt, firmScope);
  if (!out.ok) {
    const why = isSeatWait(out.detail) ? "no seat was free to read it, and it never goes to a free or paid model" : out.detail.slice(0, 220).replace(/\.$/, "");
    return { label, bullets: [`Not read this week: ${why}. It is tried again next Monday.`], done: false };
  }
  const bullets = out.text.split("\n").map((l) => l.replace(/^[-•*\s]+/, "").trim()).filter(Boolean).slice(0, pairs.length + 1);
  return { label, bullets, done: true };
}

/** The month's read reached her: it is not asked again until next month. */
export async function markMonthlyRead(env: Env, now: Date, firmScope: string, lines: readonly string[]): Promise<void> {
  await appendEvent(env, { eventType: "floor.monthly_read", actorType: "system", actorId: "floor", objectType: "floor", objectId: now.toISOString().slice(0, 7), firmScope, payload: { lines } });
}
