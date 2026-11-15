import type { Env } from "../env";
import { json, type RouteContext } from "../router";
import { appendEvent } from "../events";
import { SUBSCRIPTION_CLAIMER_EMAIL } from "../auth";
import { partnerByFirmUserId, type Partner } from "../../shared/registry/partners";
import { readApprovalReply } from "../../shared/work/approvalReply";
import { WEB_PROPERTY_CHANGE_KIND } from "../../shared/work/localJobs";
import { PARTNER_ANSWER_MAX } from "../../shared/work/blocks";

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
  // The same bound as any partner's answer (PARTNER_ANSWER_MAX): a full scope cut at 4000 rebuilt half of it (13 Nov 2026).
  if (`changes: ${words}`.length > PARTNER_ANSWER_MAX) return json({ error: "too_long", detail: `the instruction is over ${PARTNER_ANSWER_MAX} characters; shorten it rather than have the end cut off` }, { status: 400 });
  const text = `changes: ${words}`;
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
  /*
   * A FINISHED NOTE THAT LEFT A PARTNER'S ASK OUT IS REDONE BY THE SAME DOOR (14 Nov 2026, wc_bd8b68cb). Walker's November
   * note went out without Scooter's past-client check. Exactly what a partner's "redo it" reply does (reopenForRework): her
   * words as a note on the card, the card back to the sweep, and the same employee rebuilds and emails the note once.
   */
  const { REWORKABLE_AFTER_DONE } = await import("./emailThread");
  if (card.state === "DONE" && REWORKABLE_AFTER_DONE.has(card.kind ?? "")) {
    const at = new Date().toISOString();
    await ctx.env.WP_OS_DB.prepare("INSERT INTO work_card_note (id, work_card_id, author_id, body, firm_scope) VALUES (?1, ?2, ?3, ?4, ?5)")
      .bind(`wcn_${crypto.randomUUID()}`, card.id, director.partner.firmUserId, `${director.label}: ${words}`.slice(0, 4000), card.firm_scope)
      .run();
    const reopened = await ctx.env.WP_OS_DB.prepare(
      "UPDATE work_card SET state = 'OPEN', work_attempts = 0, lease_until = NULL, work_last_failure = NULL, next_action = ?2, description = substr(COALESCE(description, '') || char(10) || '• ' || ?3, 1, 16000), updated_at = ?4 WHERE id = ?1 AND state = 'DONE'",
    )
      .bind(card.id, "Rebuild the note with what was asked applied and email the revised version once.", `${director.label}, ${at}: "${text.slice(0, 2500)}"`, at)
      .run();
    if (!reopened.meta.changes) return json({ error: "not_recorded", detail: "the card was no longer DONE" }, { status: 409 });
    await appendEvent(ctx.env, {
      eventType: "work_card.directed_by_developer",
      actorType: "firm_user",
      actorId: ctx.identity.id,
      objectType: "work_card",
      objectId: card.id,
      firmScope: card.firm_scope,
      payload: { for: director.partner.firmUserId, via: "partner tail (Claude)", entered_by: ctx.identity.email, words: text, reopened_done_note: true, at },
    });
    return json({ ok: true, card_id: card.id, recorded_as: director.label, reopened: true, at });
  }
  if (card.kind !== WEB_PROPERTY_CHANGE_KIND) return json({ error: "unsupported", detail: "this door directs website jobs and reopens a finished reworkable note; other kinds take a note on the card" }, { status: 409 });
  if (card.state !== "BLOCKED") {
    /*
     * 14 Nov 2026: A DEVELOPER REBUILD ALREADY QUEUED TAKES MORE OF HER WORDS. The tail had review findings for a
     * rebuild of hers that was queued (held, between attempts); refusing meant a whole extra round afterwards. When the
     * job's pending rebuild is the developer's own and no run is in flight, the words are added to it: the same staged,
     * quiet rebuild, recorded as hers, within the partner-answer bound. Anything else is refused as before.
     */
    const { readWebPropertyChange, rebuildWords } = await import("./webPropertyChange");
    const row = card.state === "OPEN" || card.state === "IN_PROGRESS" ? await readWebPropertyChange(ctx.env, card.id) : null;
    const pending = row && row.refresh_intent === "CHANGES" && !row.current_run_id && row.rebuilt_for ? await rebuildWords(ctx.env, card.id, row) : null;
    if (!row || !pending?.developer) return json({ error: "not_waiting", detail: `the job is ${card.state}, not waiting on a word; the instruction is entered when it stops at its plan or its preview` }, { status: 409 });
    const combined = `${row.rebuilt_for!.trim()}\n\nAND: ${words}`;
    if (combined.length > PARTNER_ANSWER_MAX) return json({ error: "too_long", detail: `added to the queued instruction it would be over ${PARTNER_ANSWER_MAX} characters; shorten it` }, { status: 400 });
    const at = new Date().toISOString();
    await ctx.env.WP_OS_DB.prepare("UPDATE web_property_change SET rebuilt_for = ?2, updated_at = ?3 WHERE work_card_id = ?1 AND current_run_id IS NULL").bind(card.id, combined, at).run();
    // A retry takes its words up again from the card's answer: that answer becomes the combined words too, when it was the queued one.
    await ctx.env.WP_OS_DB.prepare("UPDATE work_card SET block_answer = ?2 WHERE id = ?1 AND block_answer = ?3").bind(card.id, combined, row.rebuilt_for).run();
    await ctx.env.WP_OS_DB.prepare("UPDATE work_card SET description = substr(COALESCE(description, '') || char(10) || '• ' || ?2, 1, 16000) WHERE id = ?1")
      .bind(card.id, `${director.label}, ${at}, added to the queued rebuild: "${words.slice(0, 2500)}"`)
      .run();
    // The record `rebuildWords` reads: the combined words are still hers, and the partner still holds his preview.
    await appendEvent(ctx.env, {
      eventType: "work_card.directed_by_developer",
      actorType: "firm_user",
      actorId: ctx.identity.id,
      objectType: "work_card",
      objectId: card.id,
      firmScope: card.firm_scope,
      payload: { for: director.partner.firmUserId, via: "partner tail (Claude)", entered_by: ctx.identity.email, words: combined, taken_up: true, added_to_queued: true, partner_holds_preview: pending.partnerHoldsPreview, own_job: false, at },
    });
    return json({ ok: true, card_id: card.id, recorded_as: director.label, added_to_queued_rebuild: true, at });
  }

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

/**
 * POST /api/work-cards/:id/developer-email { subject, text } — THE DEVELOPER'S EXACT WORDS TO THE PARTNER WHO ASKED
 * (owner, 14 Nov 2026: "Send it", for Scooter's dashboard ready email). The Mac's own identity only, for a website
 * job only. The text is sent exactly as given, as Porter, to the ONE partner who asked for the job and nobody else
 * (no cc), on the job's own thread, through `sendOrPreview` like every employee's email (so the card's "Show me first?" tick holds,
 * and `sendPartnerEmail` still refuses anyone outside the two partner addresses). Recorded as a notice (`developer:<hash>`), so the same words are never sent twice.
 */
export const DEVELOPER_EMAIL_MAX = 6000;
export async function handleDeveloperEmail(ctx: RouteContext): Promise<Response> {
  if (ctx.identity?.email.toLowerCase() !== SUBSCRIPTION_CLAIMER_EMAIL) return json({ error: "forbidden", detail: "this door is the Mac's own identity only" }, { status: 403 });
  const director = await soleDeveloper(ctx.env);
  if (!director) return json({ error: "no_developer", detail: "exactly one active developer is required" }, { status: 409 });
  const cardId = ctx.params.id ?? "";
  const body = (await ctx.request.json().catch(() => null)) as { subject?: unknown; text?: unknown } | null;
  const subject = typeof body?.subject === "string" ? body.subject.trim() : "";
  const text = typeof body?.text === "string" ? body.text.replace(/\r\n/g, "\n").trim() : "";
  if (!subject || !text) return json({ error: "invalid_input", detail: "subject and text are required" }, { status: 400 });
  if (text.length > DEVELOPER_EMAIL_MAX) return json({ error: "too_long", detail: `the text is over ${DEVELOPER_EMAIL_MAX} characters` }, { status: 400 });
  const card = await ctx.env.WP_OS_DB.prepare("SELECT id, kind, title, firm_scope, requested_by_email, preview_first, preview_owner_id FROM work_card WHERE id = ?1").bind(cardId).first<{ id: string; kind: string | null; title: string; firm_scope: string; requested_by_email: string | null; preview_first: number | null; preview_owner_id: string | null }>();
  if (!card) return json({ error: "not_found" }, { status: 404 });
  if (card.kind !== WEB_PROPERTY_CHANGE_KIND) return json({ error: "unsupported", detail: "this door emails about website jobs only" }, { status: 409 });
  const to = (card.requested_by_email ?? "").trim().toLowerCase();
  if (!to) return json({ error: "no_partner", detail: "the job was not asked for by a partner's email" }, { status: 409 });
  const { alreadyTold, recordNotice, threadRootFor } = await import("./requestReply");
  const { sendOrPreview } = await import("./previewApproval");
  const { doneReplyLaneFor } = await import("./kindRules");
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${subject}\n${text}`)))).slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
  const cause = `developer:${digest}`;
  if (await alreadyTold(ctx.env, card.id, "PREVIEW", cause)) return json({ error: "already_sent", detail: "these exact words were already sent on this job" }, { status: 409 });
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = text.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("\n");
  // Through the lane like every employee's email: the card's "Show me first?" tick still means what it says.
  const lane = await doneReplyLaneFor(ctx.env, { kind: card.kind, preview_first: card.preview_first, preview_owner_id: card.preview_owner_id }, { kind: "PREVIEW" });
  const out = await sendOrPreview(ctx.env, {
    to,
    email: { employee: "Porter", what: card.title, tldr: subject, sections: [], laidOut: { subject, text, html } },
    objectType: "work_card",
    objectId: card.id,
    firmScope: card.firm_scope,
    actorId: ctx.identity.id,
    cardKind: WEB_PROPERTY_CHANGE_KIND,
    workCardId: card.id,
    cardAsked: lane.cardAsked,
    becauseOfRule: lane.becauseOfRule,
    tickedByFirmUserId: lane.tickedByFirmUserId,
    requestedByEmail: to,
    what: card.title,
    replyOnThread: await threadRootFor(ctx.env, card.id),
  });
  await recordNotice(ctx.env, { cardId: card.id, kind: "PREVIEW", cause, to, messageId: out.threadToken ?? null, sent: out.sent, detail: `${director.label}: ${out.reason}`.slice(0, 500), firmScope: card.firm_scope });
  await appendEvent(ctx.env, { eventType: "work_card.developer_email", actorType: "firm_user", actorId: ctx.identity.id, objectType: "work_card", objectId: card.id, firmScope: card.firm_scope, payload: { to, subject, sent: out.sent, previewed: out.previewed, reason: out.reason, thread: out.threadToken ?? null, via: "partner tail (Claude)" } });
  return json({ ok: out.sent, previewed: out.previewed, to, subject, detail: out.reason, thread: out.threadToken ?? null }, { status: out.sent || out.previewed ? 200 : 502 });
}

async function soleDeveloper(env: Env): Promise<Director | null> {
  const dev = await env.WP_OS_DB.prepare("SELECT fu.id FROM firm_user fu JOIN firm_user_role fur ON fur.firm_user_id = fu.id JOIN role r ON r.id = fur.role_id WHERE r.key = ?1 AND fu.status = 'ACTIVE' ORDER BY fu.id").bind(DEVELOPER_ROLE).all<{ id: string }>();
  const holders = dev.results ?? [];
  return holders.length === 1 ? developerDirector(env, `${TAIL_PREFIX}${holders[0]!.id}`) : null;
}

// ── TAKEN OVER / HANDED BACK (owner's design, 15 Nov 2026) ─────────────────────────────────────────────────────────
//
// "Taken over": the developer is doing the card by hand. It is HELD (0227: the sweep never claims a held card), with
// a reason that says so on its face, any queued Mac run for it is withdrawn, and its block reminder is stopped. A
// partner's reply meanwhile is filed on the card and acted on by nothing (emailThread.ts).
// "Hand back": the developer's note says what was done and when it finished, and the card returns to its employee,
// who starts from that note. When the note says every ask is done and no reply came in meanwhile, the card closes and
// waits for the partner's next word; otherwise it goes back to the sweep with the note and those replies in front of it.

import { TAKEN_OVER_PREFIX, isTakenOver } from "../../shared/work/takeover";

async function theDeveloper(env: Env): Promise<Director | null> {
  const dev = await env.WP_OS_DB.prepare(
    "SELECT fu.id FROM firm_user fu JOIN firm_user_role fur ON fur.firm_user_id = fu.id JOIN role r ON r.id = fur.role_id WHERE r.key = ?1 AND fu.status = 'ACTIVE' ORDER BY fu.id",
  ).bind(DEVELOPER_ROLE).all<{ id: string }>();
  const holders = dev.results ?? [];
  return holders.length === 1 ? developerDirector(env, `${TAIL_PREFIX}${holders[0]!.id}`) : null;
}

function centralStamp(iso: string): { day: string; time: string } {
  const d = new Date(iso);
  return {
    day: new Intl.DateTimeFormat("en-GB", { timeZone: "America/Chicago", day: "numeric", month: "short" }).format(d),
    time: new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" }).format(d) + " Central",
  };
}

export type TakeoverOutcome = { ok: true; card_id: string; state: string; detail: string } | { ok: false; status: number; error: string; detail: string };

export async function takeOverCard(env: Env, cardId: string, input: { why: string; by: Director; enteredBy: string; now?: Date }): Promise<TakeoverOutcome> {
  const why = input.why.trim();
  if (why.length < 3) return { ok: false, status: 400, error: "invalid_input", detail: "why is required: what the developer is doing by hand" };
  const card = await env.WP_OS_DB.prepare("SELECT id, state, held_reason, firm_scope FROM work_card WHERE id = ?1").bind(cardId).first<{ id: string; state: string; held_reason: string | null; firm_scope: string }>();
  if (!card) return { ok: false, status: 404, error: "not_found", detail: "no such card" };
  if (isTakenOver(card.held_reason)) return { ok: false, status: 409, error: "already_taken_over", detail: card.held_reason! };
  if (!["OPEN", "IN_PROGRESS", "BLOCKED"].includes(card.state) && !card.held_reason) return { ok: false, status: 409, error: "illegal_transition", detail: `a ${card.state} card has nothing to take over` };
  const at = (input.now ?? new Date()).toISOString();
  const reason = `${TAKEN_OVER_PREFIX} (${input.by.label}, since ${at}): ${why}`.slice(0, 1000);
  await env.WP_OS_DB.prepare(
    `UPDATE work_card SET held_reason = ?2, held_by = ?3, held_at = ?4, lease_until = NULL, waiting_until = NULL, block_nag_at = NULL,
            next_action = ?5, description = substr(COALESCE(description, '') || char(10) || '• ' || ?2, 1, 16000), updated_at = ?4
      WHERE id = ?1`,
  ).bind(card.id, reason, `${TAIL_PREFIX}${input.by.partner.firmUserId}`, at, `${TAKEN_OVER_PREFIX}. Nothing runs by itself until it is handed back.`).run();
  // A run queued on the Mac for this card is withdrawn, so the claimer never picks it up mid-takeover.
  const withdrawn = await env.WP_OS_DB.prepare("UPDATE subscription_seat_run SET status = 'ABANDONED', resolution = 'taken over by a developer; withdrawn before a machine claimed it', updated_at = ?2 WHERE work_card_id = ?1 AND status = 'QUEUED'").bind(card.id, at).run();
  await appendEvent(env, { eventType: "work_card.taken_over_by_developer", actorType: "firm_user", actorId: input.by.partner.firmUserId, objectType: "work_card", objectId: card.id, firmScope: card.firm_scope, payload: { by: input.by.label, entered_by: input.enteredBy, why, at, state_before: card.state, withdrawn_runs: withdrawn.meta?.changes ?? 0 } });
  return { ok: true, card_id: card.id, state: card.state, detail: reason };
}

export async function handBackCard(env: Env, cardId: string, input: { note: string; allDone: boolean; by: Director; enteredBy: string; finishedAt?: string | null; now?: Date }): Promise<TakeoverOutcome> {
  const note = input.note.trim();
  if (note.length < 3) return { ok: false, status: 400, error: "invalid_input", detail: "note is required: what the developer did" };
  const card = await env.WP_OS_DB.prepare("SELECT id, state, held_reason, held_at, owner_id, requested_by_email, firm_scope FROM work_card WHERE id = ?1").bind(cardId).first<{ id: string; state: string; held_reason: string | null; held_at: string | null; owner_id: string | null; requested_by_email: string | null; firm_scope: string }>();
  if (!card) return { ok: false, status: 404, error: "not_found", detail: "no such card" };
  if (!isTakenOver(card.held_reason)) return { ok: false, status: 409, error: "not_taken_over", detail: "this card is not taken over, so there is nothing to hand back" };
  const now = (input.now ?? new Date()).toISOString();
  const finished = input.finishedAt && !Number.isNaN(Date.parse(input.finishedAt)) ? new Date(input.finishedAt).toISOString() : now;
  const employee = (await env.WP_OS_DB.prepare("SELECT name FROM ai_employee WHERE id = ?1").bind(card.owner_id).first<{ name: string }>().catch(() => null))?.name ?? "the employee";
  const stamp = centralStamp(finished);
  const words = `Done by a developer on ${stamp.day}, finished at ${stamp.time}; ${employee}, take it from here. ${note}`.slice(0, PARTNER_ANSWER_MAX);
  // What a partner said while the developer had it: filed on the card, never acted on, and now part of what is picked up.
  const during = (await env.WP_OS_DB.prepare(
    "SELECT COUNT(*) AS n FROM event_record WHERE object_type = 'work_card' AND object_id = ?1 AND event_type = 'work_card.reply_filed_during_takeover' AND created_at >= ?2",
  ).bind(card.id, card.held_at ?? "").first<{ n: number }>())?.n ?? 0;
  const close = input.allDone && Number(during) === 0;
  await env.WP_OS_DB.prepare("INSERT INTO work_card_note (id, work_card_id, author_id, body, firm_scope, acknowledged_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
    .bind(`wcn_${crypto.randomUUID()}`, card.id, input.by.partner.firmUserId, words, card.firm_scope, close ? now : null)
    .run();
  const partner = (card.requested_by_email ?? "").split("@")[0] || "the partner";
  const nextAction = close ? `Every ask was done by hand; waiting for ${partner.charAt(0).toUpperCase()}${partner.slice(1)}'s next instruction.` : `Start from the developer's note: ${words.slice(0, 300)}`;
  await env.WP_OS_DB.prepare(
    `UPDATE work_card SET state = ?2, held_reason = NULL, held_by = NULL, held_at = NULL, work_attempts = 0, work_steps = 0, lease_until = NULL,
            block_nag_at = NULL, next_action = ?3, description = substr(COALESCE(description, '') || char(10) || '• ' || ?4, 1, 16000), updated_at = ?5
      WHERE id = ?1`,
  ).bind(card.id, close ? "DONE" : "OPEN", nextAction, `Handed back by ${input.by.label}: ${words}`, now).run();
  await appendEvent(env, { eventType: "work_card.handed_back_by_developer", actorType: "firm_user", actorId: input.by.partner.firmUserId, objectType: "work_card", objectId: card.id, firmScope: card.firm_scope, payload: { by: input.by.label, entered_by: input.enteredBy, note: words, finished_at: finished, all_done: input.allDone, replies_during: Number(during), closed: close, at: now } });
  return { ok: true, card_id: card.id, state: close ? "DONE" : "OPEN", detail: words };
}

/** POST /api/work-cards/:id/developer-takeover { why } and /developer-hand-back { note, all_done, finished_at? } — the tail door, the Mac's identity only. */
export async function handleDeveloperTakeover(ctx: RouteContext): Promise<Response> {
  return takeoverDoor(ctx, "TAKE");
}
export async function handleDeveloperHandBack(ctx: RouteContext): Promise<Response> {
  return takeoverDoor(ctx, "BACK");
}
async function takeoverDoor(ctx: RouteContext, which: "TAKE" | "BACK"): Promise<Response> {
  if (ctx.identity?.email.toLowerCase() !== SUBSCRIPTION_CLAIMER_EMAIL) return json({ error: "forbidden", detail: "this door is the Mac's own identity only" }, { status: 403 });
  const by = await theDeveloper(ctx.env);
  if (!by) return json({ error: "no_developer", detail: "exactly one person must hold the developer role" }, { status: 409 });
  const body = (await ctx.request.json().catch(() => null)) as { why?: unknown; note?: unknown; all_done?: unknown; finished_at?: unknown } | null;
  const out = which === "TAKE"
    ? await takeOverCard(ctx.env, ctx.params.id ?? "", { why: typeof body?.why === "string" ? body.why : "", by, enteredBy: ctx.identity.email })
    : await handBackCard(ctx.env, ctx.params.id ?? "", { note: typeof body?.note === "string" ? body.note : "", allDone: body?.all_done === true, finishedAt: typeof body?.finished_at === "string" ? body.finished_at : null, by, enteredBy: ctx.identity.email });
  return out.ok ? json(out) : json({ error: out.error, detail: out.detail }, { status: out.status });
}
