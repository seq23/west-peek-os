import type { Env } from "../env";
import { json, type RouteContext } from "../router";
import { appendEvent } from "../events";
import { abandonRun } from "../ai/subscriptionSeats";
import { canAccessPrivacyLabel } from "./authorize";
import { getVisibleWorkCard } from "./workCards";
import { partnerByEmail, partnerByFirmUserId, type Partner } from "../../shared/registry/partners";
import { mergeRefusal, orderMergeTargets, type MergeTargetCard } from "../../shared/work/mergeCards";

/**
 * MERGE ONE WORK CARD INTO ANOTHER (owner, 27 Sep 2026; migration 0242).
 *
 * THE ONE WRITER of `work_card.merged_into_card_id` and `work_card_merge`. Two doors reach it — the
 * route below (the "Merge into…" button on the desk and the card page) and the checked-in one-off
 * `scripts/merge-stray-cards-2026-09-27.mjs`, which calls the same route — and both decide through
 * the pure rules in `shared/work/mergeCards.ts`, so "may this fold into that" has one answer.
 *
 * WHY IT EXISTS. On 27 Sep two of Scooter's replies were too large for the reply matcher and opened
 * new cards instead of steering the one he was answering. The desk showed four cards for one job.
 * "Stop this work" would have cancelled the strays and left their emails, attachments and hand-off
 * history stranded on dead rows; the survivor's trail would have started mid-conversation.
 *
 * WHAT MOVES to the survivor: every `inbound_message` indexed against the from card, every
 * `email_thread` about it (so a LATE REPLY on the old thread steers the survivor, not a cancelled
 * card), and every kept `request_attachment`. What STAYS on the from card and is read from there:
 * its `work_card_notice` and `work_card_hand_off` rows — the survivor's message trail
 * (`requestMessage.ts`) reads merged-in cards' rows as its own, so nothing is rewritten to lie
 * about which card a notice was sent for.
 *
 * WHAT IS SENT: nothing. No email, no notice, no effect on any PR. The from card's queued or claimed
 * Mac run is ABANDONED (it would otherwise be picked up and spend the seat on work nobody reads);
 * its `web_property_change` row is left as it was.
 *
 * WHAT CANNOT HAPPEN AFTER: the from card is CANCELLED and 0242's trigger keeps it there — "Reopen"
 * refuses, the sweep never picks CANCELLED, and `merged_into_card_id` points the reader at the card
 * that carries the work now.
 */

export interface MergeInput {
  fromCardId: string;
  intoCardId: string;
  /** A `firm_user.id` (the signed-in partner) or `system:script` for the checked-in one-off. */
  actor: string;
  reason?: string | null;
}

export interface MergeOutcome {
  ok: boolean;
  status: number;
  reason?: string;
  /** Already merged into this same card: nothing moved, the earlier merge stands. */
  already?: boolean;
  merge_id?: string;
  from?: string;
  into?: string;
  moved?: { messages: number; threads: number; files: number; runs_abandoned: number };
}

interface CardRow {
  id: string;
  title: string;
  kind: string | null;
  state: string;
  requested_by_email: string | null;
  merged_into_card_id: string | null;
  firm_scope: string;
}

export const SCRIPT_ACTOR = "system:script";

async function readCard(env: Env, id: string): Promise<CardRow | null> {
  return env.WP_OS_DB.prepare("SELECT id, title, kind, state, requested_by_email, merged_into_card_id, firm_scope FROM work_card WHERE id = ?1")
    .bind(id)
    .first<CardRow>();
}

function actorName(actor: string): string {
  if (actor === SCRIPT_ACTOR) return "the merge script";
  return partnerByFirmUserId(actor)?.firstName ?? partnerByEmail(actor)?.firstName ?? actor;
}

const bullet = (env: Env, cardId: string, line: string) =>
  env.WP_OS_DB.prepare("UPDATE work_card SET description = substr(COALESCE(description, '') || char(10) || '• ' || ?2, 1, 16000) WHERE id = ?1")
    .bind(cardId, line.slice(0, 600))
    .run();

export async function mergeCard(env: Env, input: MergeInput): Promise<MergeOutcome> {
  const from = await readCard(env, input.fromCardId);
  const into = await readCard(env, input.intoCardId);
  // IDEMPOTENT for the one-off script: the same merge asked twice is one merge, not a refusal.
  if (from && into && from.merged_into_card_id === into.id) return { ok: true, status: 200, already: true, from: from.id, into: into.id };
  const decided = mergeRefusal(from, into);
  if (!decided.ok) return { ok: false, status: decided.status, reason: decided.reason };
  if (from!.firm_scope !== into!.firm_scope) return { ok: false, status: 409, reason: "The two cards belong to different firm scopes." };
  const f = from!;
  const i = into!;
  const now = new Date();

  // THE FROM CARD LEAVES THE DESK FIRST. Guarded on `merged_into_card_id IS NULL` so two merges of
  // the same card racing each other produce exactly one; the loser sees zero rows and stops.
  const cancelled = await env.WP_OS_DB.prepare(
    `UPDATE work_card
        SET state = 'CANCELLED', merged_into_card_id = ?2, next_action = ?3,
            block_nag_at = NULL, lease_until = NULL,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?1 AND merged_into_card_id IS NULL`,
  )
    .bind(f.id, i.id, `Merged into card ${i.id}; the work carries on there.`)
    .run();
  if ((cancelled.meta?.changes ?? 0) !== 1) return { ok: false, status: 409, reason: "This card was merged by someone else a moment ago." };

  // ITS MAC RUN CANNOT RESUME. `claimRun` reads the queue by status alone, never the card's state,
  // so a QUEUED job for a cancelled card would still be handed out; CLAIMED, its report would land
  // on a card that no longer carries the work. Abandoned, the report route refuses both.
  const runs = (
    await env.WP_OS_DB.prepare("SELECT id FROM subscription_seat_run WHERE work_card_id = ?1 AND status IN ('QUEUED', 'CLAIMED')").bind(f.id).all<{ id: string }>()
  ).results ?? [];
  let runsAbandoned = 0;
  for (const r of runs) if (await abandonRun(env, r.id, `The card was merged into ${i.id}; this run is not wanted.`, now)) runsAbandoned += 1;

  const messages = await env.WP_OS_DB.prepare("UPDATE inbound_message SET work_card_id = ?2 WHERE work_card_id = ?1").bind(f.id, i.id).run();
  const threads = await env.WP_OS_DB.prepare("UPDATE email_thread SET object_id = ?2 WHERE object_type = 'work_card' AND object_id = ?1").bind(f.id, i.id).run();
  // A file the survivor already holds from the same stored message stays behind (27 Sep 2026): the
  // reply matcher can read a message onto the survivor before its stray card is merged in, and moving
  // the twin listed image0.jpeg twice in a BUILD brief. Nothing is deleted; the merged card keeps it.
  const files = await env.WP_OS_DB.prepare(
    `UPDATE request_attachment SET work_card_id = ?2
      WHERE work_card_id = ?1
        AND NOT EXISTS (SELECT 1 FROM request_attachment t WHERE t.work_card_id = ?2 AND t.eml_key = request_attachment.eml_key AND t.filename = request_attachment.filename)`,
  )
    .bind(f.id, i.id)
    .run();
  const moved = {
    messages: messages.meta?.changes ?? 0,
    threads: threads.meta?.changes ?? 0,
    files: files.meta?.changes ?? 0,
    runs_abandoned: runsAbandoned,
  };

  const id = `wcm_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    `INSERT INTO work_card_merge (id, from_card_id, into_card_id, by, reason, moved_messages, moved_threads, moved_files, firm_scope)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  )
    .bind(id, f.id, i.id, input.actor, (input.reason ?? "").trim().slice(0, 2000) || null, moved.messages, moved.threads, moved.files, f.firm_scope)
    .run();

  const who = actorName(input.actor);
  const n = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
  const why = (input.reason ?? "").trim() ? ` Reason: ${(input.reason ?? "").trim().slice(0, 160)}.` : "";
  await bullet(env, f.id, `Merged into card ${i.id} ("${i.title.slice(0, 80)}") by ${who}: ${n(moved.messages, "email")}, ${n(moved.threads, "thread")} and ${n(moved.files, "file")} now read on that card; this one stays cancelled.${why}`);
  await bullet(env, i.id, `Folded in card ${f.id} ("${f.title.slice(0, 80)}", ${f.state.toLowerCase()} → cancelled) by ${who}: ${n(moved.messages, "email")}, ${n(moved.threads, "thread")} and ${n(moved.files, "file")} moved here; its notices and hand-offs read in this card's trail.${why}`);

  const isScript = input.actor === SCRIPT_ACTOR;
  await appendEvent(env, {
    eventType: "work_card.merged",
    actorType: isScript ? "system" : "firm_user",
    actorId: input.actor,
    objectType: "work_card",
    objectId: i.id,
    firmScope: i.firm_scope,
    payload: { merge_id: id, from: f.id, into: i.id, from_state_before: f.state, reason: input.reason ?? null, ...moved },
  });

  return { ok: true, status: 200, merge_id: id, from: f.id, into: i.id, moved };
}

// ── THE ROUTES ──────────────────────────────────────────────────────────────────────────────────

/** PARTNERS ONLY: the signed-in identity must be one of the two partners, by id or by address. */
function partnerOf(ctx: RouteContext): Partner | null {
  const identity = ctx.identity;
  if (!identity) return null;
  return partnerByFirmUserId(identity.id) ?? partnerByEmail(identity.email);
}

const notAPartner = () => json({ error: "forbidden", detail: "Merging cards is a partner's decision." }, { status: 403 });

/**
 * POST /api/work-cards/:id/merge-into  { "into": "<card id>", "reason"?: "…" }
 * `:id` is the card being folded in; `into` is the survivor. Both must be visible to the reader.
 */
export async function handleMergeWorkCardInto(ctx: RouteContext): Promise<Response> {
  const from = await getVisibleWorkCard(ctx.env, ctx.identity!, ctx.params.id!);
  if (!from) return json({ error: "not_found" }, { status: 404 });
  const partner = partnerOf(ctx);
  if (!partner) return notAPartner();
  const body = (await ctx.request.json().catch(() => null)) as { into?: unknown; reason?: unknown } | null;
  const intoId = typeof body?.into === "string" ? body.into.trim() : "";
  if (!intoId) return json({ error: "invalid_input", detail: "Say which card to merge into." }, { status: 400 });
  const into = await getVisibleWorkCard(ctx.env, ctx.identity!, intoId);
  if (!into) return json({ error: "not_found", detail: "That card is not here, or you may not see it." }, { status: 404 });
  const out = await mergeCard(ctx.env, { fromCardId: from.id, intoCardId: into.id, actor: partner.firmUserId, reason: typeof body?.reason === "string" ? body.reason : null });
  return json(out.ok ? out : { error: "refused", detail: out.reason, ...out }, { status: out.status });
}

/**
 * GET /api/work-cards/:id/merge-targets — the open cards this one could fold into: same primary
 * partner first, then most recent first, never itself (`orderMergeTargets`).
 */
export async function handleListMergeTargets(ctx: RouteContext): Promise<Response> {
  const self = await getVisibleWorkCard(ctx.env, ctx.identity!, ctx.params.id!);
  if (!self) return json({ error: "not_found" }, { status: 404 });
  if (!partnerOf(ctx)) return notAPartner();
  const rows = (
    await ctx.env.WP_OS_DB.prepare(
      `SELECT id, title, state, kind, owner_id, requested_by_email, privacy_label, created_at
         FROM work_card
        WHERE firm_scope = ?1 AND state IN ('OPEN', 'IN_PROGRESS', 'BLOCKED') AND merged_into_card_id IS NULL AND id <> ?2
        ORDER BY created_at DESC
        LIMIT 200`,
    )
      .bind(self.firm_scope, self.id)
      .all<MergeTargetCard & { privacy_label: string }>()
  ).results ?? [];
  const visible = rows.filter((r) => canAccessPrivacyLabel(ctx.identity!, r.privacy_label));
  const targets = orderMergeTargets(self, visible).map(({ privacy_label: _p, ...c }) => c);
  return json({ targets });
}
