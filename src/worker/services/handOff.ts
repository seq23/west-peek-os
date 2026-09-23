import type { Env } from "../env";
import type { RouteContext } from "../router";
import { json } from "../router";
import { appendEvent } from "../events";
import { sendPartnerEmail } from "./execEmail";
import { getVisibleWorkCard } from "./workCards";
import { approverName, needsPreview, readWebPropertyChange, type WebPropertyChangeRow } from "./webPropertyChange";
import { porterContext } from "./porterContext";
import { missingFor } from "./requestMaterials";
import { decidedSoFar, planReplyForms, PREVIEW_REPLY_FORMS } from "../../shared/work/porterNotices";
import { partnerByEmail, type Partner } from "../../shared/registry/partners";
import {
  claimAck,
  decideClaim,
  decideHandOff,
  decideTakeBack,
  ownershipIntentIn,
  ownershipOf,
  secondaryApprovalRefusal,
  type OwnershipDecision,
} from "../../shared/work/partnerOwnership";
import { handOffAckEmail, handOffEmail, type TrailEntry } from "../../shared/work/handOffEmail";
import { readAsks } from "../../shared/work/approvalReply";
import { plainTitle } from "../../shared/work/siteChange";

/**
 * HAND A CARD TO THE OTHER PARTNER, AND TAKE IT BACK (owner, 23 Sep 2026; migration 0241).
 *
 * THE ONE WRITER of a card's primary and secondary during a hand-off. Three doors reach it — a reply
 * on the card's thread (`emailThread.ts#steerFromReply`), a note on the card
 * (`workCards.ts#handleAddWorkCardNote`) and the two routes below — and every one of them decides
 * through `shared/work/partnerOwnership.ts`, so "who may" has one answer.
 *
 * WHAT MOVES: `requested_by_email` becomes the new primary (and with it every requester guard in the
 * Worker, the Mac's gate and 0220's force trigger); `secondary_partner_email` becomes the partner who
 * held it; `preview_owner_id`, when it named the old primary, names the new one; a block waiting on
 * the old primary waits on the new one.
 *
 * WHAT IS SENT: exactly ONE email to the new primary, carrying the current state first (see
 * `shared/work/handOffEmail.ts`) — never a re-send of the notices the other partner already had, and
 * never a forwarded thread. On a hand-off the old primary gets Porter's one-line ack; on a take-back
 * the one email IS the ack, so a take-back sends exactly one.
 */

export type HandOffVia = "REPLY" | "NOTE" | "API" | "NOTIFICATION";
export type OwnershipAction = "HAND_OFF" | "TAKE_BACK" | "CLAIM";

export interface OwnershipChange {
  ok: boolean;
  status: number;
  reason?: string;
  action?: OwnershipAction;
  /** CLAIM only: the partner was already primary, so nothing moved and nothing was sent. */
  already_primary?: boolean;
  ack?: string;
  hand_off_id?: string;
  primary?: string;
  secondary?: string;
  /** The thread token of the one email the new primary received. */
  message_id?: string | null;
  sent?: boolean;
  send_detail?: string;
  ack_message_id?: string | null;
}

interface CardRow {
  id: string;
  title: string;
  kind: string | null;
  state: string;
  requested_by_email: string | null;
  secondary_partner_email: string | null;
  preview_owner_id: string | null;
  block_who: string | null;
  block_needed: string | null;
  held_at: string | null;
  request_json: string | null;
  firm_scope: string;
  created_at: string;
}

const IN_FLIGHT = ["OPEN", "IN_PROGRESS", "BLOCKED"];
const CARD_URL = "https://os.joinwestpeek.com/#/work";
export const cardLink = (cardId: string): string => `${CARD_URL} (card ${cardId})`;

async function readCard(env: Env, cardId: string): Promise<CardRow | null> {
  return env.WP_OS_DB.prepare(
    `SELECT id, title, kind, state, requested_by_email, secondary_partner_email, preview_owner_id, block_who, block_needed,
            held_at, request_json, firm_scope, created_at
       FROM work_card WHERE id = ?1`,
  )
    .bind(cardId)
    .first<CardRow>();
}

/**
 * Hand the card off, or take it back. `actor` is the AUTHENTICATED partner (a DKIM-checked sender or
 * the signed-in partner), never a name typed in the text.
 */
export async function changeOwnership(
  env: Env,
  input: { cardId: string; actor: string; action: OwnershipAction; target?: string | null; via: HandOffVia; said?: string | null; ackOnThread?: string | null },
): Promise<OwnershipChange> {
  const card = await readCard(env, input.cardId);
  if (!card) return { ok: false, status: 404, reason: "No such card." };
  if (!IN_FLIGHT.includes(card.state)) return { ok: false, status: 409, reason: "This card is finished; there is nothing left to hand over." };
  const decided =
    input.action === "HAND_OFF" ? decideHandOff(card, input.actor, input.target ?? null) : input.action === "TAKE_BACK" ? decideTakeBack(card, input.actor) : decideClaim(card, input.actor);
  if (!decided.ok) return { ok: false, status: decided.status, reason: decided.reason };
  if ("already" in decided) return { ok: true, status: 200, action: "CLAIM", already_primary: true, primary: decided.by.email, sent: false };
  const decision: Extract<OwnershipDecision, { ok: true }> = decided;

  const { primary, secondary, by } = decision;
  const oldPrimary = ownershipOf(card).primary;
  const ackLine = decision.action === "CLAIM" ? claimAck(by, titleOf(card)) : decision.ack;
  // Compose BEFORE the roles move: "How we got here" is the previous primary's own trail.
  const email = await composeFor(env, card, decision.action, primary, secondary, oldPrimary);
  // A block that was waiting on the old primary (or on nobody in particular) now waits on the new one.
  const blockWho =
    card.state === "BLOCKED" && (!oldPrimary || (card.block_who ?? "").toUpperCase() === oldPrimary.firstName.toUpperCase()) ? primary.firstName.toUpperCase() : card.block_who;

  await env.WP_OS_DB.prepare(
    `UPDATE work_card
        SET requested_by_email = ?2,
            secondary_partner_email = ?3,
            preview_owner_id = CASE WHEN preview_owner_id = ?4 THEN ?5 ELSE preview_owner_id END,
            block_who = ?6,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?1 AND lower(COALESCE(requested_by_email, '')) = lower(?7)`,
  )
    .bind(card.id, primary.email, secondary.email, oldPrimary?.firmUserId ?? "", primary.firmUserId, blockWho, oldPrimary?.email ?? "")
    .run();
  // A concurrent hand-off moved it first: nothing is sent on a decision that no longer holds.
  const moved = await readCard(env, card.id);
  if (moved?.requested_by_email?.toLowerCase() !== primary.email) return { ok: false, status: 409, reason: "The card changed hands while this was being decided; nothing was sent." };

  const id = `wcho_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    `INSERT INTO work_card_hand_off (id, work_card_id, action, by_email, primary_email, secondary_email, via, said, firm_scope)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  )
    .bind(id, card.id, decision.action, by.email, primary.email, secondary.email, input.via, (input.said ?? "").slice(0, 2000) || null, card.firm_scope)
    .run();

  // THE ONE EMAIL — a new conversation of its own, never a forward of the old one.
  const out = await sendPartnerEmail(env, {
    to: primary.email,
    email,
    objectType: "work_card",
    objectId: card.id,
    firmScope: card.firm_scope,
    actorId: by.firmUserId,
    cardKind: card.kind,
    events: { sent: "work_card.hand_off_emailed", notSent: "work_card.hand_off_email_not_sent" },
  }).catch((err: unknown) => ({ sent: false, reason: err instanceof Error ? err.message : String(err), subject: "", threadToken: null as string | null }));

  let ackMessageId: string | null = null;
  // THE ONE LINE to the partner who is now secondary: on a hand-off (they handed it) and a claim
  // (the other partner took responsibility). A take-back sends nothing more: its one email IS the ack.
  if (decision.action !== "TAKE_BACK") {
    const ack = await sendPartnerEmail(env, {
      to: secondary.email,
      email: handOffAckEmail({ title: titleOf(card), ack: ackLine, cardLink: cardLink(card.id), claimed: decision.action === "CLAIM" }),
      objectType: "work_card",
      objectId: card.id,
      firmScope: card.firm_scope,
      actorId: by.firmUserId,
      cardKind: card.kind,
      replyOnThread: input.ackOnThread ?? null,
      events: { sent: "work_card.hand_off_acked", notSent: "work_card.hand_off_ack_not_sent" },
    }).catch(() => ({ sent: false, threadToken: null as string | null }));
    ackMessageId = ack.sent ? ack.threadToken ?? null : null;
  }

  await env.WP_OS_DB.prepare("UPDATE work_card_hand_off SET message_id = ?2, sent = ?3, detail = ?4, ack_message_id = ?5 WHERE id = ?1")
    .bind(id, out.threadToken ?? null, out.sent ? 1 : 0, String(out.reason ?? "").slice(0, 400) || null, ackMessageId)
    .run();
  const line =
    decision.action === "CLAIM"
      ? `${by.firstName} took responsibility for this card (from the notification): ${primary.firstName} is primary, ${secondary.firstName} is secondary. ${out.sent ? `${primary.firstName} got one email with where it stands; ${secondary.firstName} got one line.` : `The email to ${primary.firstName} was NOT sent: ${out.reason}`}`
      : decision.action === "HAND_OFF"
      ? `Handed from ${by.firstName} to ${primary.firstName} (${input.via.toLowerCase()}): ${primary.firstName} is primary, ${secondary.firstName} is secondary. ${out.sent ? `${primary.firstName} got one email with where it stands.` : `The email to ${primary.firstName} was NOT sent: ${out.reason}`}`
      : `${by.firstName} took this back from ${secondary.firstName} (${input.via.toLowerCase()}): ${primary.firstName} is primary, ${secondary.firstName} is secondary. ${out.sent ? `${primary.firstName} got one email with where it stands.` : `The email was NOT sent: ${out.reason}`}`;
  await env.WP_OS_DB.prepare("UPDATE work_card SET description = substr(COALESCE(description, '') || char(10) || '• ' || ?2, 1, 16000) WHERE id = ?1")
    .bind(card.id, line.slice(0, 600))
    .run();
  await appendEvent(env, {
    eventType: decision.action === "HAND_OFF" ? "work_card.handed_off" : decision.action === "CLAIM" ? "work_card.claimed" : "work_card.taken_back",
    actorType: "firm_user",
    actorId: by.firmUserId,
    objectType: "work_card",
    objectId: card.id,
    firmScope: card.firm_scope,
    payload: { hand_off_id: id, primary: primary.email, secondary: secondary.email, via: input.via, emailed: out.sent, message_id: out.threadToken ?? null },
  });

  return {
    ok: true,
    status: 200,
    action: decision.action,
    ack: ackLine,
    hand_off_id: id,
    primary: primary.email,
    secondary: secondary.email,
    message_id: out.threadToken ?? null,
    sent: out.sent,
    send_detail: String(out.reason ?? ""),
    ack_message_id: ackMessageId,
  };
}

/**
 * THE WORDS DOOR, shared by a reply and a note: "hand this to Scooter" / "take this back". Returns
 * null when the text says neither, so the caller carries on exactly as before.
 */
export async function ownershipFromWords(
  env: Env,
  input: { cardId: string; writer: string; text: string; via: "REPLY" | "NOTE"; ackOnThread?: string | null },
): Promise<OwnershipChange | null> {
  const intent = ownershipIntentIn(input.text);
  if (!intent) return null;
  if (intent.kind === "HAND_OFF") {
    return changeOwnership(env, { cardId: input.cardId, actor: input.writer, action: "HAND_OFF", target: intent.to?.email ?? intent.named, via: input.via, said: input.text, ackOnThread: input.ackOnThread ?? null });
  }
  return changeOwnership(env, { cardId: input.cardId, actor: input.writer, action: "TAKE_BACK", via: input.via, said: input.text, ackOnThread: input.ackOnThread ?? null });
}

/**
 * A SECONDARY'S APPROVAL, REFUSED AND ANSWERED (owner, 23 Sep 2026): "Only <Primary> can approve this
 * now. Reply 'take this back' to take it over." Sent on the secondary's own thread, recorded on the card.
 */
export async function tellSecondaryRefused(
  env: Env,
  input: { cardId: string; secondary: Partner; primary: Partner; said: string; onThread?: string | null },
): Promise<{ sent: boolean; ack: string }> {
  const ack = secondaryApprovalRefusal(input.primary);
  const out = await tellPartner(env, { cardId: input.cardId, to: input.secondary, label: "Not approved", line: ack, subjectTail: `${input.primary.firstName} approves`, onThread: input.onThread ?? null });
  await env.WP_OS_DB.prepare("UPDATE work_card SET description = substr(COALESCE(description, '') || char(10) || '• ' || ?2, 1, 16000) WHERE id = ?1")
    .bind(input.cardId, `${input.secondary.firstName} (secondary) said "${input.said.slice(0, 80)}": not an approval. ${ack}`.slice(0, 600))
    .run();
  return { sent: out.sent, ack };
}

/** One line from Porter to a partner, on their own thread: a refusal, in the exec format. */
export async function tellPartner(
  env: Env,
  input: { cardId: string; to: Partner; label: string; line: string; subjectTail: string; onThread?: string | null },
): Promise<{ sent: boolean }> {
  const card = await readCard(env, input.cardId);
  if (!card) return { sent: false };
  return sendPartnerEmail(env, {
    to: input.to.email,
    email: {
      employee: "Porter",
      what: `${titleOf(card).slice(0, 40)} — ${input.subjectTail}`.slice(0, 60),
      tldr: input.line,
      sections: [
        { label: input.label, bullets: [input.line] },
        { label: "The card", bullets: [cardLink(card.id)] },
      ],
      details: null,
    },
    objectType: "work_card",
    objectId: card.id,
    firmScope: card.firm_scope,
    actorId: input.to.firmUserId,
    cardKind: card.kind,
    replyOnThread: input.onThread ?? null,
    events: { sent: "work_card.owner_reply_emailed", notSent: "work_card.owner_reply_not_sent" },
  }).catch(() => ({ sent: false }));
}

// ── THE ONE EMAIL'S CONTENTS ────────────────────────────────────────────────────────────────────

function titleOf(card: CardRow): string {
  let ask: { property_host?: string | null; ask?: string | null } = {};
  try {
    ask = card.request_json ? (JSON.parse(card.request_json) as typeof ask) : {};
  } catch {
    ask = {};
  }
  return plainTitle({ title: card.title, kind: card.kind, host: ask.property_host ?? null, subject: null, ask: ask.ask ?? null });
}

function list(json: string | null | undefined): string[] {
  try {
    const v = JSON.parse(json ?? "[]");
    return Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/** Where the card stands, in one sentence, for the partner who now holds it. Pure over the rows. */
export function standing(card: Pick<CardRow, "state" | "held_at" | "block_needed">, row: WebPropertyChangeRow | null): string {
  if (card.held_at) return "Held: nothing is built or landed until you say otherwise.";
  if (row) {
    if (row.merge_sha) return "Live: it has landed.";
    if (row.pr_url && row.check_state === "GREEN" && needsPreview(row) && !row.land_approved_at && !row.forced_by) return "The preview is ready and waiting for your approval to go live.";
    if (row.pr_url && row.check_state !== "GREEN") return "Built; the checks are running on the change.";
    if (row.plan_approved_at) return "The plan is approved and it is being built.";
    if (row.plan_filed_at) return "The plan is ready and waiting for your approval.";
    return "Received; the plan is being written.";
  }
  if (card.state === "BLOCKED") return `Waiting on you: ${(card.block_needed ?? "a question").replace(/\s+/g, " ").slice(0, 200)}`;
  return "In progress; nothing is needed from you right now.";
}

/**
 * The reply options for where it stands — THE SAME WORDS the preview and plan emails carry
 * (`shared/work/porterNotices.ts`), plus the way to hand it back.
 */
function replyOptionsFor(row: WebPropertyChangeRow | null, from: Partner): string[] {
  const handBack = `**hand this to ${from.firstName}**: give it back`;
  if (row && row.pr_url && row.check_state === "GREEN" && needsPreview(row) && !row.land_approved_at && !row.forced_by && !row.merge_sha) return [...PREVIEW_REPLY_FORMS, handBack];
  if (row && row.plan_filed_at && !row.plan_approved_at) return [...planReplyForms(readAsks(safeParse(row.asks_json)).length), handBack];
  return ["Nothing is needed now; reply with a note to steer it", handBack];
}

function safeParse(json: string | null | undefined): unknown {
  try {
    return JSON.parse(json ?? "[]");
  } catch {
    return [];
  }
}

const NOTICE_WORDS: Record<string, string> = {
  RECEIVED: "Got it, on it",
  PLAN: "The plan, for approval",
  PREVIEW: "Preview ready",
  QUESTION: "A question",
  STUCK: "Stuck",
  DONE: "Done",
};

/** What the partner wrote, without the "You asked what to do." wrapper or the quoted original. */
function spoken(body: string): string {
  return body
    .replace(/^You asked what to do\. The answer is:\s*/i, "")
    .replace(/\(Not the partner this question was addressed to; kept as a note\.\)\s*/i, "")
    .split(/\n\s*On [\s\S]{4,200}?wrote:|\n>/)[0]!
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * HOW WE GOT HERE — one dated line per prior exchange between Porter and the partner who held the
 * card: the request, each notice Porter sent them, each reply or note they wrote, each earlier
 * hand-off. Deduplicated (a reply that answered a block is both a steer and a note).
 */
export async function trailFor(env: Env, card: Pick<CardRow, "id" | "created_at" | "title">, from: Partner | null, job: string): Promise<TrailEntry[]> {
  if (!from) return [{ at: card.created_at, from: "Porter", to: "the desk", said: `opened the card: ${job}` }, ...(await handOffTrail(env, card.id))].sort((a, b) => a.at.localeCompare(b.at));
  const out: TrailEntry[] = [{ at: card.created_at, from: from.firstName, to: "Porter", said: `asked: ${job}` }];
  const notices = (
    await env.WP_OS_DB.prepare("SELECT kind, cause, sent_at FROM work_card_notice WHERE work_card_id = ?1 AND sent = 1 AND lower(sent_to) = ?2 ORDER BY sent_at")
      .bind(card.id, from.email)
      .all<{ kind: string; cause: string; sent_at: string }>()
  ).results ?? [];
  for (const n of notices) out.push({ at: n.sent_at, from: "Porter", to: from.firstName, said: n.kind === "QUESTION" && n.cause ? `A question: ${n.cause}` : NOTICE_WORDS[n.kind] ?? n.kind });
  const said = new Set<string>();
  const notes = (
    await env.WP_OS_DB.prepare("SELECT body, created_at FROM work_card_note WHERE work_card_id = ?1 AND author_id = ?2 ORDER BY created_at")
      .bind(card.id, from.firmUserId)
      .all<{ body: string; created_at: string }>()
  ).results ?? [];
  for (const n of notes) {
    const s = spoken(n.body);
    if (!s || said.has(s.toLowerCase())) continue;
    said.add(s.toLowerCase());
    out.push({ at: n.created_at, from: from.firstName, to: "Porter", said: `"${s}"` });
  }
  const steers = (
    await env.WP_OS_DB.prepare("SELECT body, created_at FROM work_steer WHERE from_card_id = ?1 AND lower(said_by) = ?2 ORDER BY created_at")
      .bind(card.id, from.email)
      .all<{ body: string; created_at: string }>()
  ).results ?? [];
  for (const n of steers) {
    const s = spoken(n.body);
    if (!s || said.has(s.toLowerCase())) continue;
    said.add(s.toLowerCase());
    out.push({ at: n.created_at, from: from.firstName, to: "Porter", said: `"${s}"` });
  }
  out.push(...(await handOffTrail(env, card.id)));
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/** Every earlier hand-off, take-back and claim on the card, one line each. */
async function handOffTrail(env: Env, cardId: string): Promise<TrailEntry[]> {
  const rows = (
    await env.WP_OS_DB.prepare("SELECT action, by_email, primary_email, created_at FROM work_card_hand_off WHERE work_card_id = ?1 ORDER BY created_at")
      .bind(cardId)
      .all<{ action: string; by_email: string; primary_email: string; created_at: string }>()
  ).results ?? [];
  return rows.map((h) => {
    const by = partnerByEmail(h.by_email);
    const to = partnerByEmail(h.primary_email);
    const said = h.action === "HAND_OFF" ? `handed it to ${to?.firstName ?? h.primary_email}` : h.action === "CLAIM" ? "took responsibility for it" : "took it back";
    return { at: h.created_at, from: by?.firstName ?? h.by_email, to: "Porter", said };
  });
}

async function composeFor(env: Env, card: CardRow, action: OwnershipAction, to: Partner, from: Partner, previousPrimary: Partner | null) {
  const row = await readWebPropertyChange(env, card.id);
  // THE PORTER EMAILS' OWN READER (porterContext): the same plain title and the same current-preview
  // line — one link per changed site, the branch alias — every other notice on this card carries.
  const ctx = row ? await porterContext(env, card.id) : null;
  const title = ctx?.title ?? titleOf(card);
  const placeholders = row ? list(row.placeholders_json) : [];
  const missing = placeholders.length ? placeholders : (await missingFor(env, card.id)).map((m) => m.item);
  const job = row?.property_host && !title.toLowerCase().includes(row.property_host.toLowerCase()) ? `${title} (${row.property_host})` : title;
  return handOffEmail({
    action,
    to,
    from,
    title,
    job,
    stands: standing(card, row),
    previewLinks: ctx?.previewLine ? [ctx.previewLine] : [],
    missing,
    replyOptions: replyOptionsFor(row, from),
    decided: row ? decidedSoFar(readAsks(safeParse(row.asks_json)), list(row.answers_json), approverName(row.plan_approved_by)) : [],
    trail: await trailFor(env, card, previousPrimary, job),
    cardLink: cardLink(card.id),
  });
}

/**
 * "TAKE RESPONSIBILITY" ON A WORK CARD'S NOTIFICATION (owner, 23 Sep 2026). Called by the
 * notification acknowledge route after it has recorded the name and the time, as it always did. The
 * partner who pressed it becomes primary and the other partner secondary; already primary, it only
 * records. A card that is finished, or a press by someone who is not a partner, moves nothing.
 */
export async function claimFromNotification(env: Env, input: { cardId: string; actor: string }): Promise<OwnershipChange> {
  return changeOwnership(env, { cardId: input.cardId, actor: input.actor, action: "CLAIM", via: "NOTIFICATION" });
}

// ── THE ROUTES ──────────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/work-cards/:id/hand-off  { "to": "scooter@westpeek.ventures" | "Scooter" | "fu_scooter_taylor" }
 * The signed-in partner must be the card's current primary.
 */
export async function handleHandOffWorkCard(ctx: RouteContext): Promise<Response> {
  const card = await getVisibleWorkCard(ctx.env, ctx.identity!, ctx.params.id!);
  if (!card) return json({ error: "not_found" }, { status: 404 });
  const body = (await ctx.request.json().catch(() => null)) as { to?: unknown; note?: unknown } | null;
  const to = typeof body?.to === "string" ? body.to.trim() : "";
  if (!to) return json({ error: "invalid_input", detail: "Say who to hand it to: the other partner." }, { status: 400 });
  const out = await changeOwnership(ctx.env, { cardId: card.id, actor: ctx.identity!.email, action: "HAND_OFF", target: to, via: "API", said: typeof body?.note === "string" ? body.note : null });
  return json(out.ok ? out : { error: "refused", detail: out.reason, ...out }, { status: out.status });
}

/** POST /api/work-cards/:id/take-back — the signed-in partner must be the card's current secondary. */
export async function handleTakeBackWorkCard(ctx: RouteContext): Promise<Response> {
  const card = await getVisibleWorkCard(ctx.env, ctx.identity!, ctx.params.id!);
  if (!card) return json({ error: "not_found" }, { status: 404 });
  const out = await changeOwnership(ctx.env, { cardId: card.id, actor: ctx.identity!.email, action: "TAKE_BACK", via: "API" });
  return json(out.ok ? out : { error: "refused", detail: out.reason, ...out }, { status: out.status });
}
