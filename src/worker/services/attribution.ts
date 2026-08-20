import type { Env } from "../env";
import { AI_EMPLOYEE_ROSTER } from "../../shared/registry/aiEmployees";

/**
 * Which machine a piece of work belongs to.
 *
 * WHY EVERY NUMBER ON THE MACHINES PAGE WAS ZERO. Sixty-four AI runs had happened and $0.31 had
 * genuinely been spent, and the Machines page showed 0 runs and $0.0000 against every one of the
 * forty-five machines. Nothing was broken in the page or in the query: `ai_run_attribution` had
 * sixty-four rows and `machine_id` was NULL in all of them. The one caller that ever set it was the
 * work-packet flow, which has never been used.
 *
 * So the plumbing existed end to end — column, index, aggregate, table — and no live path filled
 * it. The operator's reading was that the tab "tells me nothing", which was exactly right: it was
 * reporting the truth about an empty column.
 *
 * The registry already knows the answer. Every employee declares the machines they primarily work,
 * so an employee doing work attributes to their first one; nothing has to be maintained twice.
 */

/** machine.key → machine.id, resolved once per request. Forty-five rows, so no cache is warranted. */
async function machineIdForKey(env: Env, key: string): Promise<number | null> {
  const row = await env.WP_OS_DB.prepare("SELECT id FROM machine WHERE key = ?1").bind(key).first<{ id: number }>();
  return row?.id ?? null;
}

/**
 * The machine an employee's work belongs to.
 *
 * Their FIRST primary machine, not all of them: attribution answers "whose budget did this come
 * out of", which has to be a single answer. An employee spanning three machines is a real thing and
 * splitting one run across them would make every per-machine total a fraction nobody could reconcile.
 *
 * Returns null rather than guessing for anyone off the roster — an unattributed run is honest, and
 * a run attributed to the wrong machine quietly corrupts that machine's spend.
 */
export async function machineForEmployee(env: Env, employeeName: string): Promise<number | null> {
  const entry = AI_EMPLOYEE_ROSTER.find((e) => e.name === employeeName);
  const key = entry?.primaryMachineKeys[0];
  return key ? await machineIdForKey(env, key) : null;
}

/** The machine a named piece of firm machinery belongs to, for work no employee owns. */
export async function machineForKey(env: Env, key: string): Promise<number | null> {
  return await machineIdForKey(env, key);
}
