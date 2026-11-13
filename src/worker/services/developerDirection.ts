import type { Env } from "../env";
import { json, type RouteContext } from "../router";
import { appendEvent } from "../events";
import { SUBSCRIPTION_CLAIMER_EMAIL } from "../auth";
import { partnerByFirmUserId, type Partner } from "../../shared/registry/partners";
import { readApprovalReply } from "../../shared/work/approvalReply";
import { WEB_PROPERTY_CHANGE_KIND } from "../../shared/work/localJobs";

/**
 * THE DEVELOPER MAY DIRECT ANY JOB (owner ruling, 13 Nov 2026, #363; migration 0301).
 *
 * A partner asked for a website and a dashboard; the job left the dashboard out. The owner said
 * "build it now" and the OS answered, correctly by its own rule, that only the partner who asked may
 * change his job (0241). Her ruling: "i like the safety rule but i should have a developer role that
 * bypasses it … i should be able to direct any job as the developer host of west peek os."
 *
 * So the rule stands for every partner, and one role sits above it for ONE thing:
 *
 *   · WHO. A firm user holding the DEVELOPER role (granted by migration 0301 to the owner, and by
 *     nothing else). A Managing Partner without it is refused exactly as before.
 *   · WHAT. A WORK INSTRUCTION: a reply that reads as "changes: …". Never an approval of a plan or
 *     a preview, never publish, land or force, never anything that sends outside the firm or
 *     spends: those are read only from the partner the OS already requires, and a developer's
 *     "approved" on another partner's job lands nothing.
 *   · HOW. In the OS (the card's "Answer it"), by email reply on the job's thread, or THE TAIL DOOR
 *     below: when she tells her partner tail (Claude) what a job should do, the tail enters it through
 *     `POST /api/work-cards/:id/developer-changes` as the Mac's own identity. That is recorded for
 *     what it is: `tail:<her id>` on the answer, "Sequoia (developer), through the partner tail
 *     (Claude)" in the card's history, and an event with the words and the time. `tail:…` is not a
 *     partner's id, so nothing that checks for the requesting partner can ever mistake it for one.
 */
export const DEVELOPER_ROLE = "DEVELOPER";
export const TAIL_PREFIX = "tail:";

export interface Director {
  partner: Partner;
  viaTail: boolean;
  /** "Sequoia (developer)" or "Sequoia (developer), through the partner tail (Claude)". */
  label: string;
}

async function holdsDeveloper(env: Env, firmUserId: string): Promise<boolean> {
  const row = await env.WP_OS_DB.prepare(
    "SELECT 1 AS ok FROM firm_user_role fur JOIN role r ON r.id = fur.role_id JOIN firm_user fu ON fu.id = fur.firm_user_id WHERE fur.firm_user_id = ?1 AND r.key = ?2 AND fu.status = 'ACTIVE' LIMIT 1",
  )
    .bind(firmUserId, DEVELOPER_ROLE)
    .first<{ ok: number }>();
  return Boolean(row);
}

/** Who directed this, when it is the developer (herself, or through her tail); null for anyone else. Fails closed. */
export async function developerDirector(env: Env, answeredBy: string | null | undefined): Promise<Director | null> {
  const raw = String(answeredBy ?? "");
  const viaTail = raw.startsWith(TAIL_PREFIX);
  const partner = partnerByFirmUserId(viaTail ? raw.slice(TAIL_PREFIX.length) : raw);
  if (!partner) return null;
  try {
    if (!(await holdsDeveloper(env, partner.firmUserId))) return null;
  } catch {
    return null;
  }
  return { partner, viaTail, label: `${partner.firstName} (developer)${viaTail ? ", through the partner tail (Claude)" : ""}` };
}

/** Is this text a work instruction and nothing else? "changes: …" only; an approval, publish, preview or force is not. */
export function isWorkInstruction(text: string | null | undefined): boolean {
  return readApprovalReply(text).kind === "CHANGES";
}

/**
 * POST /api/work-cards/:id/developer-changes { changes } — THE TAIL DOOR. The Mac's own service
 * identity only. It speaks for the developer and for nobody else, and only in work instructions:
 * the words are stored as "changes: …", and anything that reads as an approval, a publish, a
 * preview request or a force is refused before it is written.
 */
export async function handleDeveloperChanges(ctx: RouteContext): Promise<Response> {
  if (ctx.identity?.email.toLowerCase() !== SUBSCRIPTION_CLAIMER_EMAIL) return json({ error: "forbidden", detail: "this door is the Mac's own identity only; a partner uses the card or replies by email" }, { status: 403 });
  const cardId = ctx.params.id ?? "";
  const body = (await ctx.request.json().catch(() => null)) as { changes?: unknown } | null;
  const said = typeof body?.changes === "string" ? body.changes.trim() : "";
  const words = said.replace(/^changes\s*:\s*/i, "").trim();
  if (words.length < 3) return json({ error: "invalid_input", detail: "changes is required: the work instruction, in the developer's words" }, { status: 400 });
  // Neither the words as given nor the words behind "changes:" may be an approval, a publish, a preview request or a force.
  for (const t of [said, words]) {
    const kind = readApprovalReply(t).kind;
    if (["APPROVED", "FORCED", "PUBLISH", "PREVIEW"].includes(kind)) {
      return json({ error: "not_a_work_instruction", detail: `"${t.slice(0, 80)}" reads as ${kind.toLowerCase()}: approving, publishing and forcing take the signed-in partner, never this door` }, { status: 400 });
    }
  }
  const text = `changes: ${words}`.slice(0, 4000);
  if (!isWorkInstruction(text)) return json({ error: "not_a_work_instruction", detail: "the words do not read as a work instruction" }, { status: 400 });

  const dev = await ctx.env.WP_OS_DB.prepare(
    "SELECT fu.id FROM firm_user fu JOIN firm_user_role fur ON fur.firm_user_id = fu.id JOIN role r ON r.id = fur.role_id WHERE r.key = ?1 AND fu.status = 'ACTIVE' ORDER BY fu.id",
  )
    .bind(DEVELOPER_ROLE)
    .all<{ id: string }>();
  const holders = dev.results ?? [];
  if (holders.length !== 1) return json({ error: "no_developer", detail: `${holders.length} people hold the developer role; this door speaks for exactly one` }, { status: 409 });
  const director = await developerDirector(ctx.env, `${TAIL_PREFIX}${holders[0]!.id}`);
  if (!director) return json({ error: "no_developer", detail: "the developer is not a partner on the registry" }, { status: 409 });

  const card = await ctx.env.WP_OS_DB.prepare("SELECT id, kind, state, firm_scope FROM work_card WHERE id = ?1").bind(cardId).first<{ id: string; kind: string | null; state: string; firm_scope: string }>();
  if (!card) return json({ error: "not_found" }, { status: 404 });
  if (card.kind !== WEB_PROPERTY_CHANGE_KIND) return json({ error: "unsupported", detail: "this door directs website jobs; other kinds take a note on the card" }, { status: 409 });
  if (card.state !== "BLOCKED") return json({ error: "not_waiting", detail: `the job is ${card.state}, not waiting on a word; the instruction is entered when it stops at its plan or its preview` }, { status: 409 });

  // Written the way `resumeForSecret` answers a block as the system: the answer, who it is for, and the card back to the sweep.
  const at = new Date().toISOString();
  const done = await ctx.env.WP_OS_DB.prepare(
    "UPDATE work_card SET state = 'OPEN', work_attempts = 0, work_steps = 0, lease_until = NULL, waiting_until = NULL, waiting_for = NULL, block_answer = ?2, block_answered_by = ?3, block_answered_at = ?4, block_nag_at = NULL, updated_at = ?4 WHERE id = ?1 AND state = 'BLOCKED'",
  )
    .bind(card.id, text, `${TAIL_PREFIX}${director.partner.firmUserId}`, at)
    .run();
  if (!done.meta.changes) return json({ error: "not_recorded", detail: "the job stopped waiting before the instruction was written" }, { status: 409 });
  await ctx.env.WP_OS_DB.prepare("UPDATE work_card SET description = substr(COALESCE(description, '') || char(10) || '• ' || ?2, 1, 16000) WHERE id = ?1")
    .bind(card.id, `${director.label}, ${at}: "${text.slice(0, 2500)}"`)
    .run();
  await appendEvent(ctx.env, {
    eventType: "work_card.directed_by_developer",
    actorType: "firm_user",
    actorId: ctx.identity.id,
    objectType: "work_card",
    objectId: card.id,
    firmScope: card.firm_scope,
    payload: { for: director.partner.firmUserId, via: "partner tail (Claude)", entered_by: ctx.identity.email, words: text, at },
  });
  return json({ ok: true, card_id: card.id, recorded_as: director.label, at });
}
