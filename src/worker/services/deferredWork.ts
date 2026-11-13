import type { Env } from "../env";
import type { DeferredItem } from "../../shared/work/partnerPractices";

/**
 * DATED DEFERRED WORK, FOR EVERY KIND (R14 / R23, 0254; owner, 6 Oct 2026 — lifted from Porter's
 * `deferWork`). "For next week, …" or a promised later migration is its own card for the same
 * employee and the same partner, leased until its date so the sweep leaves it alone until then and
 * then works it like any other card; the partner hears about it when it runs. Never lost on close.
 *
 * Idempotent on (source card, ask). Returns the new card's id, or null when there was nothing to do.
 * Porter's `deferWork` calls this and then makes the card a site job.
 */
export async function deferCard(
  env: Env,
  source: { id: string; title: string; owner_id: string | null; requested_by_email: string | null; firm_scope: string },
  d: DeferredItem & { words?: string | null },
  extra: { where?: string | null; nextAction?: string | null } = {},
): Promise<string | null> {
  const due = Date.parse(d.due_at);
  if (!Number.isFinite(due) || !String(d.ask ?? "").trim() || !source.owner_id) return null;
  const key = deferredKey(source.id, d.ask);
  if (await deferredCardFor(env, source.id, d.ask)) return null;
  const { createWorkCardInternal } = await import("./workCards");
  const { systemIdentity } = await import("./dealIntake");
  const date = new Date(due).toISOString().slice(0, 10);
  const made = await createWorkCardInternal(env, systemIdentity(), {
    title: `From ${source.requested_by_email ?? "a partner"}: ${d.ask.slice(0, 80)} (deferred to ${date})`,
    description: [`Deferred from card ${source.id}${extra.where ? ` on ${extra.where}` : ""} ("${source.title.slice(0, 120)}"): "${d.ask.slice(0, 1200)}"`, d.words ? `Their words: "${d.words.slice(0, 200)}"` : "", `Runs on or after ${d.due_at}.`, key].filter(Boolean).join("\n"),
    owner_type: "AI",
    owner_id: source.owner_id,
    priority: "NORMAL",
    firm_scope: source.firm_scope,
    next_action: extra.nextAction ?? `Waiting for its date (${date}); then worked like any other card, and the partner hears when it runs.`,
  });
  await env.WP_OS_DB.prepare("UPDATE work_card SET requested_by_email = ?2, lease_until = ?3, waiting_until = ?3, waiting_for = ?4, assigned_from_card_id = ?5 WHERE id = ?1")
    .bind(made.id, source.requested_by_email ?? null, new Date(due).toISOString(), `its date (${date})`, source.id)
    .run();
  return made.id;
}

const deferredKey = (sourceId: string, ask: string) => `deferred:${sourceId}:${ask.slice(0, 60)}`;

/** The card already filed for this deferred ask from this source card, or null. */
export async function deferredCardFor(env: Env, sourceId: string, ask: string): Promise<string | null> {
  // instr(), not LIKE: D1 refuses a LIKE pattern this long ("LIKE or GLOB pattern too complex") — the
  // bug Porter's own deferWork carried since 0253, which made every deferred item throw instead of filing.
  const row = await env.WP_OS_DB.prepare("SELECT id FROM work_card WHERE assigned_from_card_id = ?1 AND instr(description, ?2) > 0 LIMIT 1").bind(sourceId, deferredKey(sourceId, ask)).first<{ id: string }>();
  return row?.id ?? null;
}
