import type { Env } from "../env";
import { TranscriptionUnavailable } from "./providers/workersAiWhisper";

/**
 * What speech-to-text may spend in a day, and the stop when it has (20 Nov 2026).
 *
 * WHY. Live Meet notes ran on Nova-3 at ~28,000 neurons an hour: 15 and 16 Nov cost ~$1.40 past the
 * free 10,000 neurons a day (CONFIRMED from Cloudflare's analytics). The owner's bar is $0, and never
 * more than $0.99 a month of overage. So every transcription call adds what it spent to today's row in
 * `transcription_neuron_day` (UTC, the day the free allowance resets on), and every call reads it first.
 *
 * THE RULE, in code:
 *   · Nova-3 (diarised, ~470 neurons a minute) only while today is under the budget.
 *   · Whisper-large-v3-turbo (words only, ~46 neurons a minute) is the cheap route; it too only
 *     while today is under the budget.
 *   · Past it: `TranscriptionBudgetSpent`, a NAMED STOP. Notes pause until 00:00 UTC; nothing is
 *     billed silently. The refusal is counted on the row, and the caller shows it.
 *
 * WHAT IS COUNTED. Nova-3's neurons are what the platform reported on the call. Whisper's binding
 * reports no neurons, so its cost is the model's own reported audio duration times Cloudflare's
 * published rate ($0.00051 per audio minute, 20 Nov 2026) — derived from what the model said it
 * heard, never guessed from the slice length.
 *
 * WHAT IT CANNOT SEE. The free 10,000 neurons are the ACCOUNT's, shared with every other Worker and
 * app on it. This row counts this Worker's speech-to-text only; the 1,000-neuron margin under 10,000
 * is for the rest, and it is not a promise about them.
 */
export const TRANSCRIPTION_DAILY_NEURON_BUDGET = 9_000;

/** Cloudflare's published Whisper-large-v3-turbo rate: $0.00051 per audio minute at $0.011 per 1,000 neurons. */
export const WHISPER_NEURONS_PER_SECOND = 0.00051 / 60 / (0.011 / 1000);

export const BUDGET_STOP_CODE = "NOTES_PAUSED_DAILY_BUDGET";

export class TranscriptionBudgetSpent extends TranscriptionUnavailable {
  readonly code = BUDGET_STOP_CODE;
  constructor(public spent: number, public budget = TRANSCRIPTION_DAILY_NEURON_BUDGET) {
    super(`${BUDGET_STOP_CODE}: speech-to-text has spent ${Math.round(spent)} of its ${budget} neurons today (UTC), so notes are paused until 00:00 UTC rather than billed`);
  }
}

export function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Neurons this Worker's speech-to-text spent today (UTC). A missing table throws: an unread budget is never read as zero. */
export async function neuronsToday(env: Env, now = new Date()): Promise<number> {
  const row = await env.WP_OS_DB.prepare("SELECT neurons FROM transcription_neuron_day WHERE day = ?1").bind(utcDay(now)).first<{ neurons: number }>();
  return Number(row?.neurons ?? 0);
}

export async function recordNeurons(env: Env, neurons: number, now = new Date()): Promise<void> {
  await env.WP_OS_DB.prepare(
    `INSERT INTO transcription_neuron_day (day, neurons, calls, updated_at) VALUES (?1, ?2, 1, ?3)
     ON CONFLICT(day) DO UPDATE SET neurons = neurons + ?2, calls = calls + 1, updated_at = ?3`,
  ).bind(utcDay(now), Math.max(0, neurons), now.toISOString()).run();
}

/** Throws the named stop when today is spent; records the refusal so the day's row shows it. */
export async function requireBudget(env: Env, now = new Date()): Promise<number> {
  const spent = await neuronsToday(env, now);
  if (spent < TRANSCRIPTION_DAILY_NEURON_BUDGET) return spent;
  await env.WP_OS_DB.prepare(
    `INSERT INTO transcription_neuron_day (day, stopped, updated_at) VALUES (?1, 1, ?2)
     ON CONFLICT(day) DO UPDATE SET stopped = stopped + 1, updated_at = ?2`,
  ).bind(utcDay(now), now.toISOString()).run();
  console.error(`${BUDGET_STOP_CODE} day=${utcDay(now)} spent=${Math.round(spent)} budget=${TRANSCRIPTION_DAILY_NEURON_BUDGET}`);
  throw new TranscriptionBudgetSpent(spent);
}

export function whisperNeurons(seconds: number | null): number {
  return seconds && seconds > 0 ? seconds * WHISPER_NEURONS_PER_SECOND : 0;
}
