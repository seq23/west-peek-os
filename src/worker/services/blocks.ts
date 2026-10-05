import type { Env } from "../env";
import { ownershipOf, roleOf, secondaryApprovalRefusal } from "../../shared/work/partnerOwnership";
import type { RouteContext } from "../router";
import { appendEvent } from "../events";
import { notifyPartners, notifyQuietly } from "./notifications";
import { privacyVisibilityClause } from "./authorize";
import type { FirmUserIdentity } from "../auth";
import { allSeatAvailability } from "../ai/subscriptionSeats";
import { json } from "../router";
import { partnerByEmail, partnerByFirmUserId, partnerByName } from "../../shared/registry/partners";
import { filePreview } from "./previewApproval";
import { previewOwnerFor } from "../../shared/work/previewLane";
import { renderExecEmail, bulletsFrom, type ExecEmailInput } from "../../shared/email/execEmail";
import {
  BLOCK_ACTIONS,
  BLOCK_PROVIDERS,
  blockProblems,
  isTechnicalBlock,
  blockSentence,
  describeBlock,
  RETRYABLE_BLOCK_REASONS,
  withRetryDoor,
  type Block,
  type BlockActionKey,
  type BlockFacts,
  type BlockProvider,
  type BlockReason,
} from "../../shared/work/blocks";

/**
 * The one way a card becomes blocked, and the four ways it stops being one (16 Sep 2026).
 *
 * WHY A SINGLE FUNNEL. Thirteen places in this repo wrote `UPDATE work_card SET state = 'BLOCKED',
 * next_action = <whatever the failing function happened to be holding>`, and every one of them
 * produced a different quality of sentence. A rewrite of thirteen strings would have been true for
 * a week. `blockCard` is the only path that writes the state, so the fourteenth place has to come
 * through the catalogue too, and `scripts/validate/a-block-can-be-cleared.mjs` fails the build for
 * any service that goes round it.
 *
 * THE ANSWER HAS TO REACH THE NEXT RUN, or the button is theatre. `answerBlock` does three things
 * and needs all three: it writes the answer onto the card where every runner reads it, it leaves a
 * steering note so the general employee loop puts it ABOVE the original brief (employeeLoop.ts),
 * and it puts the card back to OPEN with its attempts reset so the sweep actually picks it up. A
 * blocked card is invisible to `claimNextCard`; recording an answer without reopening would be the
 * failure the operator described, with an extra text box.
 */

/** How long a block waits for somebody before it rings again. */
export const BLOCK_NAG_HOURS = 24;

/**
 * A TECHNICAL BLOCK RINGS LESS OFTEN THAN A QUESTION, AND HERE IS WHY.
 *
 * It appears on Work IMMEDIATELY — that is not in question and is the whole fix. What is different
 * is the ringing afterwards, and two facts pull against each other:
 *
 *   · A broken lane frequently un-breaks itself. Credit is topped up, a vendor's outage ends, a
 *     rate limit expires. A question she owes an answer to never resolves without her; a dead lane
 *     often does, and nagging her about something that has already fixed itself teaches her to
 *     ignore the nag — which is how the NEXT one gets missed.
 *   · A broken lane going unnoticed for a day is still worse than one notification. Every card in
 *     the firm can be queued behind it.
 *
 * So: forty-eight hours rather than twenty-four. One ring, well after the self-healing window, and
 * quiet hours are already honoured by the notification layer so it cannot ring at two in the
 * morning — she cannot act on a dead lane then anyway.
 */
export const TECHNICAL_BLOCK_NAG_HOURS = 48;

/** How long "send it to a different model" stands the refusing lane down for. */
export const LANE_STAND_DOWN_HOURS = 6;
/** How long "stop using this one" stands it down for. Long, and still self-clearing. */
export const LANE_PAUSE_HOURS = 24 * 7;
/** Nagging does not escalate for ever; after this many it says so and asks for an engineer. */
export const BLOCK_NAGS_BEFORE_ESCALATING = 3;

export interface BlockCardInput extends BlockFacts {
  reason: BlockReason;
  /** Scooter's office gets the notice instead of both partners. */
  tellOnly?: string;
  /** The provider key of the lane that refused, so a door can actually stand it down. */
  laneKey?: string;
  /** The provider's verbatim text, status code and all. Kept, never the headline. */
  raw?: string;
  /**
   * 0247. What was true of the world when the card stopped, as JSON, for a stop the world can undo by itself.
   * The only user today is the spend setting (`SPEND_SETTING_LANE`): see `releaseSpendSettingBlocks`.
   */
  context?: string;
}

export interface BlockedCard {
  id: string;
  title: string;
  firm_scope: string;
  /** Only used to name the employee in a notice; a card whose caller does not carry it still blocks. */
  owner_id?: string | null;
}

/**
 * WHO A STOP IS ADDRESSED TO WHEN THE CALLER DID NOT SAY: THE PARTNER WHO ASKED (5 Oct 2026).
 *
 * The catalogue's default is SEQUOIA, and since #201 the desk reads `block_who` FIRST to decide whose
 * "Needs you" a stopped card is. Almost no caller passes `who`, so a card Scooter asked for — by
 * email (`requested_by_email`) or on the page (`created_by`) — stopped as "Needs Sequoia" in his
 * view and sat out of his "Needs you" entirely: the Playwright artifact journey caught it
 * (run 36850533285). The requester is who can answer "what did you want"; the catalogue default
 * stays only for a card no partner asked for (the sweep, a machine). An explicit `who` always wins.
 * Pinned in tests/blockAddressedToRequester.test.ts.
 */
export async function requesterProvider(env: Env, cardId: string): Promise<BlockProvider | undefined> {
  const row = await env.WP_OS_DB.prepare("SELECT requested_by_email, created_by FROM work_card WHERE id = ?1")
    .bind(cardId)
    .first<{ requested_by_email: string | null; created_by: string | null }>();
  const partner = partnerByEmail(row?.requested_by_email) ?? partnerByFirmUserId(row?.created_by);
  if (!partner) return undefined;
  const provider = partner.firstName.toUpperCase();
  return (BLOCK_PROVIDERS as readonly string[]).includes(provider) ? (provider as BlockProvider) : undefined;
}

/**
 * Put a card down with a reason a partner can read and act on.
 *
 * Returns the sentence written onto the card, which is what every caller already returned as its
 * `detail` — so a service swapping its UPDATE for this call keeps its own contract.
 */
export async function blockCard(env: Env, card: BlockedCard, input: BlockCardInput, now: Date = new Date()): Promise<string> {
  const block = describeBlock(input.reason, { ...input, who: input.who ?? (await requesterProvider(env, card.id)) });
  // A block that fails its own standard is a bug in the catalogue, not a thing to ship quietly.
  // Thrown rather than logged: the trigger in 0173 would refuse the row anyway, and a service
  // discovering that at the database is a worse place to find out.
  const problems = blockProblems(block);
  if (problems.length > 0) {
    throw new Error(`block reason "${input.reason}" is not fit for a partner to read: ${problems.join("; ")}`);
  }

  const sentence = blockSentence(block);
  await env.WP_OS_DB.prepare(
    `UPDATE work_card
        SET state = 'BLOCKED',
            next_action = ?2,
            block_reason = ?3, block_trying = ?4, block_stopped = ?5, block_needed = ?6,
            block_who = ?7, block_actions_json = ?8,
            blocked_at = ?9, block_nag_at = ?10, block_nags = 0,
            block_answer = NULL, block_answered_by = NULL, block_answered_at = NULL,
            -- Which lane refused, and its verbatim words. 0185: the doors need the first to act on
            -- it, and the second is the appendix she can open when she wants the real text.
            block_lane = ?11, block_lane_name = ?12, block_raw = ?13,
            block_context = ?14,
            lease_until = NULL,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?1`,
  )
    .bind(
      card.id, sentence.slice(0, 900),
      block.reason, block.trying.slice(0, 400), block.stopped, block.needed.slice(0, 900),
      block.who, JSON.stringify(block.actions),
      now.toISOString(), nagAt(now, block.reason),
      input.laneKey ?? null, input.lane ?? null, (input.raw ?? "").slice(0, 900) || null,
      input.context?.slice(0, 400) ?? null,
    )
    .run();

  await appendEvent(env, {
    eventType: "work_card.blocked",
    actorType: "system",
    actorId: "work_sweep",
    objectType: "work_card",
    objectId: card.id,
    firmScope: card.firm_scope,
    payload: { reason: block.reason, who: block.who, actions: block.actions.map((a) => a.key) },
  });
  return sentence;
}

/**
 * ── A STOP THE FIRM'S OWN SETTING CAUSED, AND THE WORLD CAN UNDO (1 Oct 2026) ───────────────────────
 *
 * Parker's November Room stopped on `free_only_cannot_serve_protected_work`. The owner moved the setting; the
 * card stayed stopped until somebody pressed something. A stop that the world has since fixed should not wait
 * for a person to notice. So a card stopped by the spend setting records the state it stopped in
 * (`block_context`), and every sweep tick compares: when the setting now permits the work and it did not
 * before, the card goes back in the queue by itself.
 *
 * ONCE PER CHANGE, NEVER IN A LOOP. A card is released only when the state has moved from "did not permit"
 * to "permits". If it fails again in the new state it re-blocks with THAT state recorded, so the next tick
 * sees no change and leaves it — the owner's Retry button is the door from there.
 */
export const SPEND_SETTING_LANE = "spend_lever";
export const SPEND_SETTING_NAME = "the spend setting";

export interface SpendState {
  /** FREE_ONLY | MODERATE | OPEN. */
  lever: string;
  /** An awake, not-out-of-usage seat whose claimer declared it can search the web. */
  seatSearch: boolean;
}

/**
 * Does this state let the card's work run? A paid setting lets any of it run. A search-capable seat lets run
 * ONLY a SEARCH call — a seat cannot serve a call that carries a document or a picture, or one that is not a
 * search — so the seat clause is available only to a card whose failed call was a search call (review of #217:
 * recording "a seat could search" globally made a stop on some other call look already-permitted, and the card
 * would then never be released when the setting moved).
 */
export function spendStatePermits(state: SpendState, searchCall = false): boolean {
  return state.lever !== "FREE_ONLY" || (searchCall && state.seatSearch);
}

/** Was the call that the spend setting refused a live-web SEARCH call? The refusal names the call's class. */
export function isSearchCallRefusal(text: string | null | undefined): boolean {
  return /marked 'search'/.test(text ?? "");
}

/** The firm's spend state right now. Never throws: an unreadable policy reads as the safest answer. */
export async function currentSpendState(env: Env, firmScope: string, now: Date = new Date()): Promise<SpendState> {
  let lever = "FREE_ONLY";
  try {
    const row = await env.WP_OS_DB.prepare("SELECT spend_lever FROM budget_policy WHERE firm_scope = ?1 ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .bind(firmScope)
      .first<{ spend_lever: string | null }>();
    lever = row?.spend_lever ?? "MODERATE";
  } catch {
    // An unreadable policy reads as the strictest setting, so nothing is released on a guess.
    lever = "FREE_ONLY";
  }
  let seatSearch = false;
  try {
    seatSearch = (await allSeatAvailability(env, now)).some((a) => a.available && a.canSearch === true);
  } catch {
    seatSearch = false;
  }
  return { lever, seatSearch };
}

export const spendStateJson = (s: SpendState, searchCall = false): string =>
  JSON.stringify({ lever: s.lever, seat_search: s.seatSearch, search_call: searchCall });

function readSpendContext(raw: string | null | undefined): (SpendState & { searchCall: boolean }) | null {
  try {
    const j = JSON.parse(raw ?? "") as { lever?: unknown; seat_search?: unknown; search_call?: unknown };
    if (typeof j.lever !== "string") return null;
    return { lever: j.lever, seatSearch: j.seat_search === true, searchCall: j.search_call === true };
  } catch {
    return null;
  }
}

/**
 * Put back in the queue every card the spend setting stopped, whose world has since changed for the better.
 * Returns the ids released. Cheap: one indexed-ish query, and nothing at all when no card is so blocked.
 */
export async function releaseSpendSettingBlocks(env: Env, now: Date = new Date()): Promise<string[]> {
  const rows =
    (
      await env.WP_OS_DB.prepare(
        `SELECT id, title, firm_scope, owner_id, block_context FROM work_card
          WHERE state = 'BLOCKED' AND block_lane = ?1
            -- A HELD CARD KEEPS ITS UNDERLYING STATE AND THE SWEEP SKIPS IT (0227): releasing it would report a resume
            -- that cannot happen and lose its blocked state while held (review of #217).
            AND held_at IS NULL LIMIT 50`,
      )
        .bind(SPEND_SETTING_LANE)
        .all<{ id: string; title: string; firm_scope: string; owner_id: string | null; block_context: string | null }>()
    ).results ?? [];
  if (rows.length === 0) return [];
  const released: string[] = [];
  const byFirm = new Map<string, SpendState>();
  for (const r of rows) {
    // A card with no readable record of what stopped it is not released on a guess; its Retry button is the door.
    const then = readSpendContext(r.block_context);
    if (!then) continue;
    let nowState = byFirm.get(r.firm_scope);
    if (!nowState) {
      nowState = await currentSpendState(env, r.firm_scope, now);
      byFirm.set(r.firm_scope, nowState);
    }
    if (!spendStatePermits(nowState, then.searchCall) || spendStatePermits(then, then.searchCall)) continue;
    const why = nowState.lever !== "FREE_ONLY" ? `the spend setting is now ${nowState.lever === "OPEN" ? "Open" : "Moderate"}` : "a subscription seat can now search the web";
    const res = await env.WP_OS_DB.prepare(
      `UPDATE work_card
          SET state = 'OPEN', work_attempts = 0, work_steps = 0, lease_until = NULL,
              work_last_failure = NULL, work_last_failure_at = NULL,
              next_action = ?2,
              block_answer = ?3, block_answered_by = 'work_sweep', block_answered_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              block_nag_at = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?1 AND state = 'BLOCKED' AND block_lane = ?4 AND held_at IS NULL`,
    )
      .bind(r.id, `Back in the queue: ${why}, so this is being tried again.`.slice(0, 900), `AUTO-RETRY: ${why}`, SPEND_SETTING_LANE)
      .run();
    if ((res.meta?.changes ?? 0) === 0) continue;
    await appendEvent(env, {
      eventType: "work_card.auto_released",
      actorType: "system",
      actorId: "work_sweep",
      objectType: "work_card",
      objectId: r.id,
      firmScope: r.firm_scope,
      payload: { reason: "spend_setting_changed", was: then, now: nowState },
    });
    released.push(r.id);
  }
  return released;
}

/**
 * "TRY EVERY STOPPED CARD AGAIN" — the one button for a morning when several cards stopped for a reason that
 * has since been fixed. Every BLOCKED card whose reason is one a retry can help (see RETRYABLE_BLOCK_REASONS),
 * except one she has already sent to an engineer: that stays until they have fixed it. Returns how many.
 */
export async function retryAllStopped(env: Env, identity: FirmUserIdentity): Promise<{ retried: number; ids: string[]; skipped: number }> {
  const identityId = identity.id;
  /*
   * ONLY WHAT SHE COULD HAVE RETRIED ONE AT A TIME (review of #217). A bulk door that skipped the gates the single
   * door and the board apply would be a way round them: an analyst, a secondary partner or a user scoped to another
   * firm could reopen cards they cannot see or individually clear. So the candidate set is exactly the board's —
   * the caller's privacy visibility and firm scope — and each card then goes through the single door's own rule:
   * a card's SECONDARY partner does not clear its block (0241); it is the primary's.
   */
  const scopes = identity.authorityScopes.filter((s) => s.scopeKey === "firm_scope").map((s) => s.scopeValue);
  const isManagingPartner = identity.roles.includes("MANAGING_PARTNER");
  const marks = RETRYABLE_BLOCK_REASONS.map((_, i) => `?${i + 1}`).join(", ");
  const visibility = privacyVisibilityClause(identity, "privacy_label");
  const rows =
    (
      await env.WP_OS_DB.prepare(
        `SELECT id, firm_scope, requested_by_email, secondary_partner_email FROM work_card
          WHERE state = 'BLOCKED' AND COALESCE(block_who, '') <> 'ENGINEER' AND block_reason IN (${marks}) AND ${visibility}
          LIMIT 200`,
      )
        .bind(...RETRYABLE_BLOCK_REASONS)
        .all<{ id: string; firm_scope: string; requested_by_email: string | null; secondary_partner_email: string | null }>()
    ).results ?? [];
  const ids: string[] = [];
  let skipped = 0;
  for (const r of rows) {
    // Firm scope: a user scoped to another firm retries none of this firm's cards. A managing partner holds every scope.
    if (!isManagingPartner && !scopes.includes(r.firm_scope)) {
      skipped += 1;
      continue;
    }
    // The single door's rule: the secondary partner does not clear a block on a card — that is the primary's call.
    if (roleOf(r, identity.email) === "SECONDARY") {
      skipped += 1;
      continue;
    }
    const card = await env.WP_OS_DB.prepare("SELECT id, title, firm_scope FROM work_card WHERE id = ?1").bind(r.id).first<{ id: string; title: string; firm_scope: string }>();
    if (!card) continue;
    await reopen(env, r.id, identityId, "RETRY", "tried again with every other stopped card");
    await record(env, card, identityId, "RETRY", "retry all stopped");
    ids.push(r.id);
  }
  return { retried: ids.length, ids, skipped };
}

/** POST /api/work-cards/retry-stopped — a person, never an employee. */
export async function handleRetryStoppedCards(ctx: RouteContext): Promise<Response> {
  if (!ctx.identity) return json({ error: "human_required" }, { status: 403 });
  const out = await retryAllStopped(ctx.env, ctx.identity);
  const left = out.skipped > 0 ? ` ${out.skipped} more ${out.skipped === 1 ? "is" : "are"} not yours to clear — that is the primary partner's call.` : "";
  return json({
    ok: true,
    retried: out.retried,
    skipped: out.skipped,
    said:
      out.retried === 0
        ? `Nothing was stopped in a way a retry could help.${left}`
        : `${out.retried} stopped card${out.retried === 1 ? "" : "s"} back in the queue. They try again within a few minutes.${left}`,
  });
}

/** When this block rings again if nobody has acted. A fault gets a gentler interval than a question. */
export function nagAt(now: Date, reason?: string | null): string {
  const hours = isTechnicalBlock(reason) ? TECHNICAL_BLOCK_NAG_HOURS : BLOCK_NAG_HOURS;
  return new Date(now.getTime() + hours * 3_600_000).toISOString();
}

/** The block as stored, for the page and for the resurfacing sweep. */
export interface StoredBlock {
  id: string;
  title: string;
  firm_scope: string;
  owner_id: string | null;
  block_reason: string | null;
  block_trying: string | null;
  block_stopped: string | null;
  block_needed: string | null;
  block_who: string | null;
  block_actions_json: string | null;
  blocked_at: string | null;
  block_nag_at: string | null;
  block_nags: number;
}

export const BLOCK_COLUMNS =
  "id, title, firm_scope, owner_id, block_reason, block_trying, block_stopped, block_needed, " +
  "block_who, block_actions_json, blocked_at, block_nag_at, COALESCE(block_nags, 0) AS block_nags";

/**
 * NOTHING STAYS STUCK SILENTLY.
 *
 * A block nobody has acted on rings again a day later, and keeps ringing. This is the same rule
 * the roster already holds for employees — they cannot drop work they own — applied to the system
 * itself, which could previously let a block age into the bottom of a list. After three unanswered
 * rings the notice says plainly that it has been asked three times, because at that point the
 * problem is not that she missed it.
 */
export async function resurfaceStaleBlocks(env: Env, now: Date): Promise<StoredBlock[]> {
  const rows = (
    await env.WP_OS_DB.prepare(
      `SELECT ${BLOCK_COLUMNS} FROM work_card
        WHERE state = 'BLOCKED' AND block_answered_at IS NULL
          -- HELD (0227, Wave D). A card blocked and then held keeps state = 'BLOCKED' underneath
          -- — HELD is not a state value, held_at IS NOT NULL is the fact — so without this
          -- clause a held card's stale pre-hold nag clock would still ring every 24 hours, which is
          -- exactly the silence this feature promises and the thing tests/hold.test.ts proves
          -- negatively.
          AND held_at IS NULL
          AND block_nag_at IS NOT NULL AND block_nag_at < ?1
        ORDER BY blocked_at ASC LIMIT 5`,
    )
      .bind(now.toISOString())
      .all<StoredBlock>()
  ).results ?? [];

  for (const row of rows) {
    const nags = (row.block_nags ?? 0) + 1;
    const days = row.blocked_at ? Math.max(1, Math.round((now.getTime() - Date.parse(row.blocked_at)) / 86_400_000)) : 1;
    const who = await employeeName(env, row.owner_id);
    const body = [
      row.block_stopped ?? "",
      `What would clear it: ${row.block_needed ?? "—"}`,
      nags >= BLOCK_NAGS_BEFORE_ESCALATING
        ? `This is the ${nags}th time of asking. If it is not yours to answer, send it to an engineer from the Work page.`
        : "Answer it, change it or drop it on the Work page.",
    ].join(" ");
    await notifyQuietlyOrPartners(env, row, {
      title: `Still waiting on you: ${who} on "${row.title.slice(0, 60)}" (${days} day${days === 1 ? "" : "s"})`,
      body,
      dedupeKey: `work_card:${row.id}:block_nag:${nags}`,
    });
    await env.WP_OS_DB.prepare("UPDATE work_card SET block_nags = ?2, block_nag_at = ?3 WHERE id = ?1")
      .bind(row.id, nags, nagAt(now, row.block_reason))
      .run();
  }
  return rows;
}

async function notifyQuietlyOrPartners(
  env: Env,
  row: Pick<StoredBlock, "id" | "firm_scope" | "block_who">,
  n: { title: string; body: string; dedupeKey: string },
): Promise<void> {
  const input = {
    kind: "MEETING" as const,
    severity: "WARNING" as const,
    title: n.title,
    body: n.body.slice(0, 600),
    objectType: "work_card",
    objectId: row.id,
    dedupeKey: n.dedupeKey,
    firmScope: row.firm_scope,
  };
  if (row.block_who === "SCOOTER") {
    // Asked of the registry, not typed. `block_who` names a partner by first name; the registry is
    // what turns that into the `firm_user` the notice is addressed to.
    await notifyQuietly(env, { ...input, firmUserId: partnerByName(row.block_who)!.firmUserId });
    return;
  }
  await notifyPartners(env, input);
}

async function employeeName(env: Env, id: string | null): Promise<string> {
  if (!id) return "An employee";
  const row = await env.WP_OS_DB.prepare("SELECT name FROM ai_employee WHERE id = ?1").bind(id).first<{ name: string }>();
  return row?.name ?? id;
}

// ── The four doors ────────────────────────────────────────────────────────────────────────────

export interface UnblockInput {
  action: BlockActionKey;
  /** What she typed, or the key of a fixed choice. */
  text?: string;
  choice?: string;
}

export interface UnblockResult {
  ok: boolean;
  state: string;
  /** What to tell her happened, in her own terms. */
  said: string;
}

/**
 * ANSWER — the door that has to work.
 *
 * Three writes, and the card is genuinely back in the queue:
 *
 *   1. `block_answer` on the card, which is where a specialised runner (the packet chain, the
 *      monthly note) reads it — those do not run the general loop and would never see a note;
 *   2. a `work_card_note`, which the general employee loop re-reads on EVERY step and places above
 *      the original brief, and which it must acknowledge in words before it can carry on;
 *   3. state OPEN with `work_attempts` and `work_steps` back to zero, because the sweep claims
 *      OPEN and IN_PROGRESS cards and a blocked one is invisible to it.
 *
 * `allow_page` is the one choice that also DOES something: a block asking permission to open a
 * page is answered by granting it, not by describing the grant in prose the loop has to interpret.
 */
export async function answerBlock(
  env: Env,
  cardId: string,
  identityId: string,
  input: UnblockInput,
): Promise<UnblockResult> {
  const card = await env.WP_OS_DB.prepare(
    `SELECT id, title, state, firm_scope, owner_id, block_reason, block_who, description, requested_by_email, kind
       FROM work_card WHERE id = ?1`,
  )
    .bind(cardId)
    .first<{
      id: string;
      title: string;
      state: string;
      firm_scope: string;
      owner_id: string | null;
      block_reason: string | null;
      block_who: string | null;
      description: string | null;
      requested_by_email: string | null;
      kind: string | null;
    }>();
  if (!card) return { ok: false, state: "", said: "That card is not here." };
  if (card.state !== "BLOCKED") {
    return { ok: false, state: card.state, said: "This work is not blocked, so there is nothing to clear." };
  }

  const who = await employeeName(env, card.owner_id);
  const typed = (input.text ?? "").trim();

  if (input.action === "DROP") {
    if (typed.length < 2) return { ok: false, state: card.state, said: "Say in a few words why you are dropping it, so the record makes sense later." };
    await env.WP_OS_DB.prepare(
      `UPDATE work_card
          SET state = 'CANCELLED', next_action = NULL,
              description = substr(COALESCE(description, '') || char(10) || '• Dropped by you: ' || ?2, 1, 16000),
              block_answer = ?2, block_answered_by = ?3, block_answered_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              block_nag_at = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?1`,
    )
      .bind(card.id, typed.slice(0, 1000), identityId)
      .run();
    await record(env, card, identityId, "DROP", typed);
    // Fire-and-forget, like every other notification path in this file: the drop itself is already
    // committed above, and a failure telling the requester must never undo or fail the drop.
    await notifyRequesterOfDrop(env, card, who, typed).catch((err) => console.error("drop notice failed", err));
    return { ok: true, state: "CANCELLED", said: `Dropped. ${who} stops asking, and your reason is on the record.` };
  }

  if (input.action === "ESCALATE") {
    // STILL BLOCKED, DELIBERATELY. Escalating is not clearing: the work has not moved and saying it
    // has would be the "runs but inert" failure in a nicer jacket. What changes is who it is
    // addressed to and that somebody outside this office now knows.
    await env.WP_OS_DB.prepare(
      `UPDATE work_card
          SET block_who = 'ENGINEER',
              block_needed = ?2,
              block_answer = ?3, block_answered_by = ?4, block_answered_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              block_nag_at = ?5, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?1`,
    )
      .bind(
        card.id,
        "An engineer has to look at this one — it is not something you can answer.",
        typed.slice(0, 1000) || "Sent to an engineer.",
        identityId,
        nagAt(new Date()),
      )
      .run();
    await notifyPartners(env, {
      kind: "MEETING",
      severity: "WARNING",
      title: `Sent to an engineer: ${who} on "${card.title.slice(0, 60)}"`,
      body: `${typed || "No extra detail was given."} They will need the card and what it was asked to do. It stays blocked until they have fixed it.`,
      objectType: "work_card",
      objectId: card.id,
      dedupeKey: `work_card:${card.id}:escalated`,
      firmScope: card.firm_scope,
    });
    await record(env, card, identityId, "ESCALATE", typed);
    return { ok: true, state: "BLOCKED", said: "Sent to an engineer. It stays on this list until they have fixed it, so it cannot go quiet." };
  }

  /*
   * ── THE FOUR DOORS A TECHNICAL BLOCK NEEDS (17 Sep 2026) ───────────────────────────────────
   *
   * The test this feature is judged against: SHE COULD HAVE FIXED THAT NIGHT'S FAILURE WITHOUT AN
   * ENGINEER. Every one of these is a real write, and every one ends with the card back in the
   * queue — a door that records an intention and leaves the work blocked is the same "runs but
   * inert" defect answering a question used to be.
   */
  if (input.action === "RETRY" || input.action === "ANOTHER_LANE" || input.action === "PAUSE_LANE") {
    const lane = await laneOf(env, cardId);
    let said: string;
    if (input.action === "RETRY") {
      said = `Back in the queue. ${who} tries again within a few minutes, the same way as before.`;
    } else {
      if (!lane) {
        return {
          ok: false,
          state: card.state,
          said: "This one did not record which model refused it, so there is nothing to stand down. Try it again, or send it to an engineer.",
        };
      }
      const hours = input.action === "PAUSE_LANE" ? LANE_PAUSE_HOURS : LANE_STAND_DOWN_HOURS;
      await standLaneDown(env, lane.key, identityId, hours, card.title);
      said =
        input.action === "PAUSE_LANE"
          ? `${lane.name} is stood down for a week — nothing in the firm will use it until then, and it comes back on its own. The work is back in the queue.`
          : `${lane.name} is stood down for six hours, so the next run has to take a different one. ${who} tries again within a few minutes.`;
    }
    await reopen(env, cardId, identityId, input.action, typed);
    await record(env, card, identityId, input.action, typed || said);
    return { ok: true, state: "OPEN", said };
  }

  if (input.action === "HAND_ON") {
    // The employee is named by `choice`, because the roster is not something the catalogue can
    // know — the page offers whoever is actually employed and the server refuses anybody else.
    const seat = (input.choice ?? "").trim();
    const to = seat
      ? await env.WP_OS_DB.prepare("SELECT id, name FROM ai_employee WHERE id = ?1 AND status = 'ACTIVE'").bind(seat).first<{ id: string; name: string }>()
      : null;
    if (!to) return { ok: false, state: card.state, said: "Pick which employee should take it." };
    if (to.id === card.owner_id) return { ok: false, state: card.state, said: `${who} already has this one. Pick somebody else.` };
    await env.WP_OS_DB.prepare(
      `UPDATE work_card
          SET owner_type = 'AI', owner_id = ?2, state = 'OPEN', work_attempts = 0, work_steps = 0, lease_until = NULL,
              work_last_failure = NULL, work_last_failure_at = NULL,
              next_action = ?3,
              block_answer = ?4, block_answered_by = ?5, block_answered_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              block_nag_at = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?1`,
    )
      .bind(card.id, to.id, `Handed to ${to.name} by you.`.slice(0, 900), `Handed to ${to.name}. ${typed}`.trim().slice(0, 1000), identityId)
      .run();
    await leaveNote(env, card.id, identityId, `This has moved to you from ${who}. ${typed || "It stopped on the way through and you are starting it again."}`);
    await record(env, card, identityId, "HAND_ON", `${to.name}: ${typed}`);
    return { ok: true, state: "OPEN", said: `${to.name} has it now and starts within a few minutes.` };
  }

  // ANSWER and CHANGE both put the work back in the queue; they differ in what the employee reads.
  if (input.action === "CHANGE") {
    if (typed.length < 5) return { ok: false, state: card.state, said: "Write the job again in your own words — that is what they will work from." };
    await env.WP_OS_DB.prepare(
      `UPDATE work_card
          SET state = 'OPEN', title = ?1, next_action = ?2, work_attempts = 0, work_steps = 0, lease_until = NULL,
              block_answer = ?3, block_answered_by = ?4, block_answered_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              block_nag_at = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?5`,
    )
      .bind(card.title, typed.slice(0, 900), typed.slice(0, 1000), identityId, card.id)
      .run();
    await leaveNote(env, card.id, identityId, `What you asked for has changed. This is the job now: ${typed}`);
    await record(env, card, identityId, "CHANGE", typed);
    return { ok: true, state: "OPEN", said: `${who} picks this up again within a few minutes, working from your new words.` };
  }

  // ANSWER.
  const choice = (input.choice ?? "").trim();
  const answer = typed || choiceLabel(choice);
  if (!answer) return { ok: false, state: card.state, said: "Type your answer, or pick one of the options." };

  const grantsPage = choice === "allow_page";
  await env.WP_OS_DB.prepare(
    `UPDATE work_card
        SET state = 'OPEN', work_attempts = 0, work_steps = 0, lease_until = NULL,
            allows_browser = CASE WHEN ?2 = 1 THEN 1 ELSE allows_browser END,
            next_action = ?3,
            block_answer = ?4, block_answered_by = ?5, block_answered_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            block_nag_at = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?1`,
  )
    .bind(card.id, grantsPage ? 1 : 0, `You answered: ${answer}`.slice(0, 900), answer.slice(0, 1000), identityId)
    .run();

  // The steering note is what the general loop reads. Written as her answer to a question, not as a
  // new instruction, so the employee resumes rather than restarting.
  await leaveNote(env, card.id, identityId, `You asked what to do. The answer is: ${answer}`);
  await record(env, card, identityId, "ANSWER", answer);
  return {
    ok: true,
    state: "OPEN",
    said: grantsPage
      ? `${who} can open that page now and picks the work up again within a few minutes.`
      : `${who} picks this up again within a few minutes, with your answer in front of them.`,
  };
}

function choiceLabel(choice: string): string {
  if (choice === "allow_page") return "Yes — open it.";
  if (choice === "deny_page") return "No — carry on without opening it.";
  return "";
}

/**
 * A note the employee must acknowledge, written by the partner who answered.
 *
 * Written directly rather than through `handleAddWorkCardNote`: that handler refuses a card it
 * thinks nobody will read, and by the time this runs the card is already back to OPEN.
 */
async function leaveNote(env: Env, cardId: string, authorId: string, body: string): Promise<void> {
  await env.WP_OS_DB.prepare("INSERT INTO work_card_note (id, work_card_id, author_id, body) VALUES (?1, ?2, ?3, ?4)")
    .bind(`wcn_${crypto.randomUUID()}`, cardId, authorId, body.slice(0, 4000))
    .run();
}

/** Which lane this block named, if any. Null means nothing to stand down. */
async function laneOf(env: Env, cardId: string): Promise<{ key: string; name: string } | null> {
  const row = await env.WP_OS_DB.prepare("SELECT block_lane, block_lane_name FROM work_card WHERE id = ?1")
    .bind(cardId)
    .first<{ block_lane: string | null; block_lane_name: string | null }>();
  if (!row?.block_lane) return null;
  return { key: row.block_lane, name: row.block_lane_name ?? row.block_lane };
}

/**
 * STAND A LANE DOWN — the write that makes "stop using this one" a fact rather than a promise.
 *
 * `paused_until`, not `enabled = 0`. `enabled` is the operator's own switch on the Integrations
 * page with no clock attached to it, and a button on a work card that turns a vendor off for ever,
 * from a surface with no way to turn it back on, is a trap. A pause names who set it and why (the
 * database refuses one that does not — migration 0185) and expires by itself.
 *
 * Every place that picks a lane to run on honours this; `validate:stopped-cards` is what keeps that
 * true for the next one somebody writes.
 */
async function standLaneDown(env: Env, laneKey: string, byId: string, hours: number, cardTitle: string): Promise<void> {
  const until = new Date(Date.now() + hours * 3_600_000).toISOString();
  await env.WP_OS_DB.prepare(
    "UPDATE provider_registry SET paused_until = ?2, paused_reason = ?3, paused_by = ?4 WHERE provider_key = ?1",
  )
    .bind(laneKey, until, `Stood down from the work card "${cardTitle.slice(0, 80)}" after it refused the work.`, byId)
    .run();
  await appendEvent(env, {
    eventType: "provider.stood_down",
    actorType: "firm_user",
    actorId: byId,
    objectType: "provider_registry",
    objectId: laneKey,
    firmScope: "west-peek",
    payload: { until, hours },
  });
}

/** Put the card back in the queue with a clean slate — the half every fault door shares. */
async function reopen(env: Env, cardId: string, identityId: string, action: string, typed: string): Promise<void> {
  await env.WP_OS_DB.prepare(
    `UPDATE work_card
        SET state = 'OPEN', work_attempts = 0, work_steps = 0, lease_until = NULL,
            -- The failure is cleared because it is no longer the current fact about this card.
            -- What happened is on the record; what the page shows is where the work IS.
            work_last_failure = NULL, work_last_failure_at = NULL,
            next_action = ?2,
            block_answer = ?3, block_answered_by = ?4, block_answered_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            block_nag_at = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?1`,
  )
    .bind(cardId, "Being tried again — you sent it back.", `${action}${typed ? `: ${typed}` : ""}`.slice(0, 1000), identityId)
    .run();
}

/**
 * DROP TELLS WHOEVER ASKED, IN A PREVIEW SHE APPROVES BEFORE IT GOES (her explicit ask, 22 Sep
 * 2026).
 *
 * "Dropped" used to be silent past the record on the card: the requester — if there was one — went
 * on believing the work was still coming, and found out only by asking. One case (Scooter's) had to
 * be hand-filed as a `preview_approval` because nothing did this automatically.
 *
 * SKIPPED WHEN THERE IS NOBODY TO TELL. `requested_by_email` is set only by `openAssignmentCard`
 * after DKIM/DMARC passed (migration 0160); a card she opened herself, or a scheduled duty, has none
 * — there is no requester who is owed an explanation, so this is silent, not a notice to nobody.
 *
 * FILED, NEVER SENT DIRECTLY. This goes through the exact door `filePreview` is — a PENDING
 * `preview_approval` row with `laneReason: 'ASKED_FOR'`, on her Home and in her inbox with Send it /
 * Send it back / Dismiss. There is no direct-send path here and none should exist: a drop notice is
 * still outbound mail on the firm's behalf, and every one of those goes through the lane.
 *
 * THE BUSY-EXECUTIVE SHAPE, in the employee's own voice — the same `renderExecEmail` every other
 * partner-facing notice in this codebase uses (see `replyToRequester` in `requestReply.ts`), with
 * the already-required, already-captured drop reason (`block_answer`) as the finding.
 */
async function notifyRequesterOfDrop(
  env: Env,
  card: { id: string; title: string; firm_scope: string; requested_by_email: string | null; kind: string | null },
  who: string,
  reason: string,
): Promise<void> {
  const requester = (card.requested_by_email ?? "").trim().toLowerCase();
  if (!requester) return;

  const owner = previewOwnerFor({ requestedByEmail: requester });
  const findings = bulletsFrom(reason);
  const email: ExecEmailInput = {
    employee: who,
    what: `dropped — ${card.title.slice(0, 60)}`,
    tldr: `${who} dropped what you asked for: ${card.title}. Nothing is coming unless you ask again.`,
    sections: [
      { label: "What you asked", bullets: [card.title] },
      { label: "What's true", bullets: findings.length ? findings : ["No further detail was given."] },
      {
        label: "Your call",
        bullets: [
          "Nothing, if this no longer matters.",
          `Ask again and ${who} will pick it back up — reply and say so.`,
        ],
      },
    ],
    details: reason,
  };
  const rendered = renderExecEmail(email);
  await filePreview(env, {
    employee: who,
    what: `dropped — ${card.title.slice(0, 60)}`,
    subject: rendered.subject,
    bodyText: rendered.text,
    bodyHtml: rendered.html,
    recipient: requester,
    laneReason: "ASKED_FOR",
    owner,
    workCardId: card.id,
    cardKind: card.kind ?? null,
    firmScope: card.firm_scope,
  });
}

async function record(env: Env, card: { id: string; firm_scope: string }, actorId: string, action: string, text: string): Promise<void> {
  await appendEvent(env, {
    eventType: "work_card.unblocked",
    actorType: "firm_user",
    actorId,
    objectType: "work_card",
    objectId: card.id,
    firmScope: card.firm_scope,
    payload: { action, said: text.slice(0, 300) },
  });
}

// ── HTTP ──────────────────────────────────────────────────────────────────────────────────────

/** POST /api/work-cards/:id/unblock — the button on the card. */
export async function handleUnblockWorkCard(ctx: RouteContext): Promise<Response> {
  const cardId = ctx.params.id;
  if (!cardId) return json({ error: "invalid_input" }, { status: 400 });
  const body = (await ctx.request.json().catch(() => null)) as { action?: unknown; text?: unknown; choice?: unknown } | null;
  const action = String(body?.action ?? "") as BlockActionKey;
  if (!BLOCK_ACTIONS.includes(action)) {
    return json(
      {
        error: "invalid_input",
        detail:
          "Say what you are doing with it: answering it, changing it, dropping it, sending it to an engineer, " +
          "trying it again, sending it to a different model, standing that model down, or handing it to somebody else.",
      },
      { status: 400 },
    );
  }
  // A PERSON CLEARS A BLOCK. An employee answering the question it asked would be the loop talking
  // to itself, which is the failure work_card_note's author_id column already refuses.
  if (!ctx.identity) return json({ error: "human_required" }, { status: 403 });

  /*
   * THE SECONDARY DOES NOT CLEAR A BLOCK (0241). A block on a partner's card is that card's
   * decision — the plan, the preview, the missing items — and it is the PRIMARY's. The secondary is
   * told who decides and how to take the card over; their words can still go on the card as a note.
   */
  const owners = await ctx.env.WP_OS_DB.prepare("SELECT requested_by_email, secondary_partner_email FROM work_card WHERE id = ?1")
    .bind(cardId)
    .first<{ requested_by_email: string | null; secondary_partner_email: string | null }>();
  if (owners && roleOf(owners, ctx.identity.email) === "SECONDARY") {
    return json({ ok: false, error: "secondary", detail: secondaryApprovalRefusal(ownershipOf(owners).primary!) }, { status: 403 });
  }

  const out = await answerBlock(ctx.env, cardId, ctx.identity.id, {
    action,
    text: typeof body?.text === "string" ? body.text : undefined,
    choice: typeof body?.choice === "string" ? body.choice : undefined,
  });
  return json(out, { status: out.ok ? 200 : 409 });
}

/** The stored block, read back for a page. Null for a card that is not blocked. */
export function blockOf(
  row: Partial<StoredBlock> & { state?: string; block_lane?: string | null; block_lane_name?: string | null; block_raw?: string | null },
): (Block & { blockedAt: string | null; lane: string | null; laneName: string | null; raw: string | null }) | null {
  if (row.state !== "BLOCKED" || !row.block_stopped) return null;
  let actions: Block["actions"] = [];
  try {
    actions = JSON.parse(row.block_actions_json ?? "[]") as Block["actions"];
  } catch {
    actions = [];
  }
  return {
    reason: (row.block_reason ?? "a_question_for_you") as BlockReason,
    trying: row.block_trying ?? "",
    stopped: row.block_stopped,
    needed: row.block_needed ?? "",
    who: (row.block_who ?? "SEQUOIA") as Block["who"],
    // THE DOORS ARE STORED WHEN THE CARD STOPS, so a card that stopped before "try it again" existed would
    // keep its old list for ever. Added on the way out, so every stopped card is retryable.
    actions: withRetryDoor(actions, row.block_reason),
    blockedAt: row.blocked_at ?? null,
    // 0185 — what the doors act on, and the appendix behind "show me what it said". `raw` is the
    // provider's verbatim text and is NEVER the headline: the page keeps it shut until she opens it.
    lane: row.block_lane ?? null,
    laneName: row.block_lane_name ?? null,
    raw: row.block_raw ?? null,
  };
}
