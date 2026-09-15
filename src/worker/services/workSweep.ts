import type { Env } from "../env";
import type { RouteContext } from "../router";
import type { FirmUserIdentity } from "../auth";
import { appendEvent } from "../events";
import { notifyPartners, notifyQuietly } from "./notifications";
import { deckStillBeingRead, workCard } from "./employeeWork";
import { STEPS_PER_TICK } from "../../shared/work/employeeLoop";

/** A Productions card, by kind — kept here (not imported) so the sweep and productions.ts do not import each other. */
function isProductionsKind(kind: string | null | undefined): boolean {
  return kind === "PRODUCTIONS_CUSTOMERS" || kind === "PRODUCTIONS_PRESS" || kind === "PRODUCTIONS_MONTHLY";
}
import { replyToRequester } from "./requestReply";

/**
 * The sweep that works the cards employees own (14 Sep 2026).
 *
 * ─── The review that produced this, in the operator's words ─────────────────────────────────
 *
 * "the work in progress which is putting the incoming decks into the system should have been done
 * but they still say in progress" — four cards owned by Wyatt, IN_PROGRESS since 9 September,
 * never touched. And: "there needs to be a way to move a task from in progress to done or
 * automatically do that once its done and i can check it."
 *
 * ─── What was wrong, end to end ────────────────────────────────────────────────────────────
 *
 *   1. ASSIGNMENT DID NOT CAUSE WORK. `employeeWork.workCard` is the whole employee — four moves,
 *      each a governed model call — and it ran only when a person pressed the button on a card.
 *      A system that opens a card for an employee and then waits for the partner to press a button
 *      has assigned the work to the partner.
 *   2. "IN PROGRESS" MEANT NOTHING. A card could be in that state with zero runs behind it, so the
 *      word on the screen was not a fact about the work.
 *   3. AN OUTCOME TOLD NOBODY. A card going DONE or BLOCKED wrote a row. No notice reached a
 *      partner, so a finished job and an untouched one looked the same from Home.
 *   4. TWO RUNNERS, NO LOCK. The button and any automatic runner could work the same card at once
 *      and both spend model budget on it.
 *   5. FAILURE RETRIED FOR EVER, OR NEVER. A run that died (provider error, budget refusal) left
 *      the card exactly as it was, so an automatic runner would retry it every tick until the end
 *      of time, and a manual one would never know it had failed.
 *
 * ─── What this does about each ─────────────────────────────────────────────────────────────
 *
 *   1. A scheduled job (`employee_work_sweep`, every five minutes) calls `sweepOnce`, which works
 *      ONE waiting AI-owned card through the same `workCard` the button runs. One per tick: the
 *      cron invocation has a CPU budget and every card step is a model call.
 *   2. A card is claimed before it is worked (`lease_until`), so IN_PROGRESS now means "a run
 *      holds it or has held it". `work_attempts` counts the runs.
 *   3. DONE and BLOCKED each notify BOTH partners, with the finding or the question in the notice
 *      and the card named — inside the OS, dedupe-keyed, quiet hours respected.
 *   4. The lease is the lock. A claim is a conditional UPDATE; whoever loses it does not run.
 *   5. Three attempts, then the card goes BLOCKED with the last failure written on it and the
 *      partners told. A card that cannot be worked is a decision for a person, not a loop.
 *
 * The employee decides HOW, never WHETHER — that line in employeeWork.ts still holds. What changed
 * is who presses the button: the firm does, on a schedule, for work the firm has already assigned.
 */

export const MAX_WORK_ATTEMPTS = 3;
export const LEASE_MINUTES = 15;

export interface SweepCard {
  id: string;
  title: string;
  kind: string | null;
  owner_id: string | null;
  state: string;
  work_attempts: number;
  firm_scope: string;
  requested_by_email?: string | null;
}

/** Who the sweep is when it works a card: the firm, acting on its own assignment. */
export function sweepIdentity(firmScope = "west-peek"): FirmUserIdentity {
  return {
    id: "system:work_sweep",
    email: "work-sweep@joinwestpeek.com",
    fullName: "Work sweep",
    status: "ACTIVE",
    roles: ["MANAGING_PARTNER"],
    authorityScopes: [{ scopeKey: "firm_scope", scopeValue: firmScope }],
  };
}

function sweepContext(env: Env, firmScope: string): RouteContext {
  return {
    request: new Request("https://os.joinwestpeek.com/internal/work-sweep"),
    env,
    identity: sweepIdentity(firmScope),
    params: {},
  };
}

/**
 * Claim the oldest waiting card, or null. The claim is the lock: the UPDATE is conditional on the
 * lease being free, so two runners racing for the same card cannot both win it.
 */
export async function claimNextCard(env: Env, now: Date): Promise<SweepCard | null> {
  const nowIso = now.toISOString();
  const candidate = await env.WP_OS_DB.prepare(
    `SELECT id, title, kind, owner_id, state, COALESCE(work_attempts, 0) AS work_attempts, firm_scope, requested_by_email
       FROM work_card
      WHERE owner_type = 'AI' AND owner_id IS NOT NULL
        AND state IN ('OPEN', 'IN_PROGRESS')
        AND (lease_until IS NULL OR lease_until < ?1)
        AND COALESCE(work_attempts, 0) < ?2
      ORDER BY created_at ASC
      LIMIT 1`,
  )
    .bind(nowIso, MAX_WORK_ATTEMPTS)
    .first<SweepCard>();
  if (!candidate) return null;
  const lease = new Date(now.getTime() + LEASE_MINUTES * 60_000).toISOString();
  const claimed = await env.WP_OS_DB.prepare(
    `UPDATE work_card
        SET lease_until = ?2, work_attempts = COALESCE(work_attempts, 0) + 1,
            -- An OPEN card is fresh or reopened by a person: its step allowance starts again.
            work_steps = CASE WHEN state = 'OPEN' THEN 0 ELSE COALESCE(work_steps, 0) END,
            state = 'IN_PROGRESS'
      WHERE id = ?1 AND (lease_until IS NULL OR lease_until < ?3)`,
  )
    .bind(candidate.id, lease, nowIso)
    .run();
  if ((claimed.meta?.changes ?? 0) !== 1) return null;
  return { ...candidate, work_attempts: candidate.work_attempts + 1, state: "IN_PROGRESS" };
}

async function releaseLease(env: Env, cardId: string): Promise<void> {
  await env.WP_OS_DB.prepare("UPDATE work_card SET lease_until = NULL WHERE id = ?1").bind(cardId).run();
}

async function employeeName(env: Env, id: string | null): Promise<string> {
  if (!id) return "An employee";
  const row = await env.WP_OS_DB.prepare("SELECT name FROM ai_employee WHERE id = ?1").bind(id).first<{ name: string }>();
  return row?.name ?? id;
}

/**
 * Tell both partners what happened to the card. INSIDE THE OS, never emailed; dedupe-keyed on the
 * card and the outcome so a re-run of the same outcome does not ring twice.
 */
export async function announceOutcome(
  env: Env,
  card: SweepCard,
  outcome: "DONE" | "BLOCKED" | "HANDED_ON",
  detail: string,
): Promise<{ emailed: string | null }> {
  const who = await employeeName(env, card.owner_id);
  // SCOOTER'S PERSONAL-AGENCY WORK IS TOLD TO SCOOTER. A West Peek Productions card is a duty
  // inside his office (productions.ts); a notice about it on Sequoia's desk would be the wrong
  // desk. The email went from the runner itself, to him only.
  if (isProductionsKind(card.kind)) {
    await notifyQuietly(env, {
      firmUserId: "fu_scooter_taylor",
      kind: "MEETING",
      severity: outcome === "BLOCKED" ? "WARNING" : "INFO",
      title: outcome === "DONE" ? `${who} finished "${card.title.slice(0, 70)}" — check your email` : `${who} is blocked on "${card.title.slice(0, 70)}"`,
      body: detail.slice(0, 600),
      objectType: "work_card",
      objectId: card.id,
      dedupeKey: `work_card:${card.id}:${outcome}:${card.work_attempts}`,
      firmScope: card.firm_scope,
    });
    return { emailed: null };
  }
  await notifyPartners(env, {
    kind: "MEETING",
    severity: outcome === "BLOCKED" ? "WARNING" : "INFO",
    title:
      outcome === "DONE"
        ? `${who} finished "${card.title.slice(0, 70)}" — check it on Work`
        : outcome === "HANDED_ON"
          ? `${who} handed "${card.title.slice(0, 70)}" to a colleague`
          : `${who} is blocked on "${card.title.slice(0, 70)}"`,
    body: detail.slice(0, 600),
    objectType: "work_card",
    objectId: card.id,
    dedupeKey: `work_card:${card.id}:${outcome}:${card.work_attempts}`,
    firmScope: card.firm_scope,
  });
  // A REQUEST THAT CAME BY EMAIL IS ANSWERED BY EMAIL — at the end, not at the hand-off. The
  // partner asked for a thing, not for a tour of who holds the card.
  if (outcome === "HANDED_ON") return { emailed: null };
  const reply = await replyToRequester(env, card, outcome, who, detail);
  return { emailed: reply.sent ? reply.to : null };
}

export interface SweepResult {
  status: "SUCCEEDED" | "FAILED";
  summary: string;
  card: SweepCard | null;
  outcome: "DONE" | "BLOCKED" | "HANDED_ON" | "PROGRESSED" | "FAILED" | "NOTHING_WAITING" | "WAITING_ON_DECK";
}

/** How long a card waits for its deck to be read before the sweep looks at it again. */
export const DECK_WAIT_MINUTES = 15;

/**
 * Work one card. `runners` is injectable so tests can prove the sweep's own logic — claim, attempt
 * count, notices, the three-strikes rule — without a model or a browser.
 */
/**
 * A THIRD ATTEMPT THAT DIED MID-RUN LEFT THE CARD NOWHERE. Helios Grid, 14 Sep 14:09: the run was
 * killed hard (no `finally` ran), so the lease expired with `work_attempts = 3` and the card still
 * IN_PROGRESS — unclaimable (at the cap) and never finalised (the cap check lives in the run that
 * died). Every sweep now settles such cards first: BLOCKED, the failure named, the partners told.
 */
export async function settleAbandonedCards(env: Env, now: Date): Promise<SweepCard[]> {
  const rows = (
    await env.WP_OS_DB.prepare(
      `SELECT id, title, kind, owner_id, state, COALESCE(work_attempts, 0) AS work_attempts, firm_scope, requested_by_email
         FROM work_card
        WHERE owner_type = 'AI' AND state = 'IN_PROGRESS'
          AND COALESCE(work_attempts, 0) >= ?1
          AND lease_until IS NOT NULL AND lease_until < ?2`,
    )
      .bind(MAX_WORK_ATTEMPTS, now.toISOString())
      .all<SweepCard>()
  ).results ?? [];
  for (const card of rows) {
    const why = `Could not finish after ${MAX_WORK_ATTEMPTS} attempts. The last attempt was cut off before it could report (the run was killed mid-step). Decide what to do with it: reassign, rewrite the brief, or cancel.`;
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'BLOCKED', next_action = ?2, lease_until = NULL WHERE id = ?1 AND state = 'IN_PROGRESS'")
      .bind(card.id, why)
      .run();
    await announceOutcome(env, card, "BLOCKED", why);
  }
  return rows;
}

export async function sweepOnce(
  env: Env,
  now: Date,
  runners: {
    general?: (env: Env, ctx: RouteContext, cardId: string, options: { maxSteps: number }) => Promise<{ finished: boolean; blocked: boolean; detail: string; steps: Array<{ action: string; detail: string }> }>;
    deckRework?: (env: Env, card: SweepCard) => Promise<{ finished: boolean; blocked: boolean; detail: string }>;
    productions?: (env: Env, card: SweepCard) => Promise<{ finished: boolean; blocked: boolean; detail: string }>;
  } = {},
): Promise<SweepResult> {
  await settleAbandonedCards(env, now);
  const card = await claimNextCard(env, now);
  if (!card) {
    return { status: "SUCCEEDED", summary: "nothing waiting: every card an employee owns is done, blocked, or being worked", card: null, outcome: "NOTHING_WAITING" };
  }

  // THE DECK COMES FIRST. If the company's deck is queued and not yet read, this attempt does not
  // count and the card is parked until the reader has had a turn; another card gets this tick.
  const unread = card.kind === "DECK_REWORK" || isProductionsKind(card.kind) ? null : await deckStillBeingRead(env, card.title, card.id);
  if (unread) {
    const until = new Date(now.getTime() + DECK_WAIT_MINUTES * 60_000).toISOString();
    await env.WP_OS_DB.prepare(
      "UPDATE work_card SET lease_until = ?2, work_attempts = COALESCE(work_attempts, 1) - 1, state = 'OPEN' WHERE id = ?1",
    )
      .bind(card.id, until)
      .run();
    return {
      status: "SUCCEEDED",
      summary: `"${card.title.slice(0, 60)}" is waiting for its deck (${unread.filename}) to be read; the reader runs every 15 minutes.`,
      card: { ...card, work_attempts: card.work_attempts - 1, state: "OPEN" },
      outcome: "WAITING_ON_DECK",
    };
  }

  let finished = false;
  let blocked = false;
  let detail = "";
  // Did the run END WELL — every step it took was a real move (search, visit, note) and it simply
  // ran out of steps for this tick? Then the card is progressed, not failed, and the next tick
  // continues it. Only a run that died, or an employee that chose nothing usable, costs an attempt.
  let progressed = false;
  let handedOn = false;
  try {
    if (card.kind === "DECK_REWORK") {
      const run = runners.deckRework ?? (await import("./deck")).runDeckRework;
      const out = await run(env, card);
      finished = out.finished;
      blocked = out.blocked;
      detail = out.detail;
    } else if (isProductionsKind(card.kind)) {
      // Walker's West Peek Productions duty: one search, every URL checked, one email to Scooter.
      const run = runners.productions ?? (await import("./productions")).runProductionsCard;
      const out = await run(env, card);
      finished = out.finished;
      blocked = out.blocked;
      detail = out.detail;
    } else {
      const run = runners.general ?? workCard;
      const out = await run(env, sweepContext(env, card.firm_scope), card.id, { maxSteps: STEPS_PER_TICK });
      finished = out.finished;
      blocked = out.blocked;
      const last = out.steps[out.steps.length - 1];
      detail = last ? last.detail : out.detail;
      handedOn = last?.action === "assigned";
      progressed = out.steps.length > 0 && out.steps.every((s) => !["failed", "unclear"].includes(s.action));
    }
  } catch (err) {
    detail = err instanceof Error ? err.message : String(err);
  } finally {
    await releaseLease(env, card.id);
  }

  const fresh = await env.WP_OS_DB.prepare("SELECT state, next_action FROM work_card WHERE id = ?1")
    .bind(card.id)
    .first<{ state: string; next_action: string | null }>();
  const state = fresh?.state ?? card.state;

  if (handedOn) {
    await announceOutcome(env, card, "HANDED_ON", detail);
    await appendEvent(env, {
      eventType: "work_card.swept",
      actorType: "system",
      actorId: "work_sweep",
      objectType: "work_card",
      objectId: card.id,
      firmScope: card.firm_scope,
      payload: { outcome: "HANDED_ON", attempt: card.work_attempts },
    });
    return { status: "SUCCEEDED", summary: `"${card.title.slice(0, 60)}" ${detail.slice(0, 160)}`, card, outcome: "HANDED_ON" };
  }
  if (state === "DONE" || finished) {
    const { emailed } = await announceOutcome(env, card, "DONE", detail || "Finished. The findings are on the card.");
    await appendEvent(env, {
      eventType: "work_card.swept",
      actorType: "system",
      actorId: "work_sweep",
      objectType: "work_card",
      objectId: card.id,
      firmScope: card.firm_scope,
      payload: { outcome: "DONE", attempt: card.work_attempts },
    });
    return { status: "SUCCEEDED", summary: `"${card.title.slice(0, 60)}" finished (attempt ${card.work_attempts})${emailed ? `, ${emailed} emailed` : ""}: ${detail.slice(0, 160)}`, card, outcome: "DONE" };
  }
  if (state === "BLOCKED" || blocked) {
    const question = fresh?.next_action ?? detail;
    await announceOutcome(env, card, "BLOCKED", question);
    return { status: "SUCCEEDED", summary: `"${card.title.slice(0, 60)}" is blocked: ${question.slice(0, 160)}`, card, outcome: "BLOCKED" };
  }

  if (progressed) {
    // THIS TICK'S WORK IS DONE AND THE CARD IS NOT. Hand it back for the next tick: the claim's
    // attempt is given back, because an invocation that did what it was asked is not a failure.
    await env.WP_OS_DB.prepare("UPDATE work_card SET work_attempts = MAX(COALESCE(work_attempts, 1) - 1, 0) WHERE id = ?1").bind(card.id).run();
    return {
      status: "SUCCEEDED",
      summary: `"${card.title.slice(0, 60)}" progressed (${STEPS_PER_TICK} step(s) this tick): ${detail.slice(0, 160)}. The next tick continues it.`,
      card: { ...card, work_attempts: Math.max(card.work_attempts - 1, 0) },
      outcome: "PROGRESSED",
    };
  }

  // Neither done nor blocked: the run died or the employee chose nothing usable.
  if (card.work_attempts >= MAX_WORK_ATTEMPTS) {
    const why = `Could not finish after ${MAX_WORK_ATTEMPTS} attempts. Last attempt: ${detail || "no usable action was chosen"}. Decide what to do with it: reassign, rewrite the brief, or cancel.`;
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'BLOCKED', next_action = ?2 WHERE id = ?1")
      .bind(card.id, why)
      .run();
    await announceOutcome(env, card, "BLOCKED", why);
    return { status: "SUCCEEDED", summary: `"${card.title.slice(0, 60)}" blocked after ${MAX_WORK_ATTEMPTS} failed attempts and handed to you: ${detail.slice(0, 140)}`, card, outcome: "BLOCKED" };
  }
  // THE SWEEP RAN; THE CARD IS NOT DONE YET. Reporting this as a failed RUN painted "FAILED" on the
  // Work page for a card that was simply on its first attempt of three (Vantage Robotics, 14 Sep,
  // 13:32). The run succeeded at its job — it worked the card — and the card's own state says the
  // rest. A run fails when the sweep itself could not do its work, not when an employee needs
  // another go.
  return {
    status: "SUCCEEDED",
    summary: `"${card.title.slice(0, 60)}" attempt ${card.work_attempts} of ${MAX_WORK_ATTEMPTS} did not finish: ${detail.slice(0, 160)}. It will be tried again.`,
    card,
    outcome: "FAILED",
  };
}
