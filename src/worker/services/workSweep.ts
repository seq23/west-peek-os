import type { Env } from "../env";
import type { RouteContext } from "../router";
import type { FirmUserIdentity } from "../auth";
import { appendEvent } from "../events";
import { notifyPartners, notifyQuietly } from "./notifications";
import { deckStillBeingRead, workCard } from "./employeeWork";
import { blockCard, resurfaceStaleBlocks } from "./blocks";
import { STEPS_PER_TICK } from "../../shared/work/employeeLoop";
import { attemptsAllowedFor, isLaneFailure, readLaneFailure, type LaneFailure } from "../../shared/ai/laneFailure";

/** A Productions card, by kind — kept here (not imported) so the sweep and productions.ts do not import each other. */
function isProductionsKind(kind: string | null | undefined): boolean {
  return kind === "PRODUCTIONS_CUSTOMERS" || kind === "PRODUCTIONS_PRESS" || kind === "PRODUCTIONS_MONTHLY" || kind === "PRODUCTIONS_HIRE_SEARCH";
}
import { replyToRequester } from "./requestReply";
import { PRODUCTIONS_PARTNER } from "../../shared/registry/partners";

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
  // PARKER'S PACKET ANNOUNCES ITSELF: the finished packet is emailed to both partners and posted
  // as its own notice (services/roomPacket.ts emailPacket), so a second "finished the card" notice
  // would ring twice for one thing. A BLOCKED packet card still tells both partners below.
  if (card.kind === "ROOM_PACKET" && outcome === "DONE") return { emailed: null };
  // BLOG HELP EMAILS ITSELF: the runner files the deliverable, emails the partner who asked in the
  // busy-executive format, and posts its own notice to them (services/blogHelp.ts). A second
  // "finished the card" email would be the same thing twice. A BLOCKED one still tells both below.
  if (card.kind === "BLOG_HELP" && outcome === "DONE") return { emailed: card.requested_by_email ?? null };
  if (isProductionsKind(card.kind)) {
    await notifyQuietly(env, {
      // Whose agency it is, asked of the registry rather than typed. See shared/registry/partners.ts.
      firmUserId: PRODUCTIONS_PARTNER.firmUserId,
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
    const why = await blockCard(env, card, {
      reason: "stopped_part_way",
      trying: card.title,
      employee: await employeeName(env, card.owner_id),
      who: isProductionsKind(card.kind) ? "SCOOTER" : "SEQUOIA",
    }, now);
    await announceOutcome(env, card, "BLOCKED", why);
  }
  return rows;
}

/**
 * The technical account of a failed attempt, kept WHERE AN ENGINEER LOOKS and not on the partner's
 * sentence. Deleting it would trade one bad outcome for another: a block nobody can diagnose.
 */
/**
 * WHICH LANE WAS BEHIND THIS FAILURE, and what it said.
 *
 * The sweep holds a step's `detail`, which for the general employee loop IS the run's
 * `failure_reason` — but for the specialised chains (the Room packet, blog help, the Productions
 * duties) it is that runner's own sentence, and the lane is invisible from here. So the run itself
 * is asked: the most recent run attributed to this card that did not complete, and the provider row
 * it was pointed at.
 *
 * THIS IS THE LOOKUP THAT DID NOT EXIST ON 17 SEP. `ai_run.failure_reason` held
 * `provider_failure:provider_http_400` and nothing on the card path ever read it, which is why a
 * card that had been refused by a lane three times still said "queued".
 */
async function laneBehindTheFailure(
  env: Env,
  cardId: string,
  stepDetail: string,
): Promise<{ failure: LaneFailure; key: string | null; name: string | null; raw: string }> {
  const run = await env.WP_OS_DB.prepare(
    `SELECT r.failure_reason, pr.provider_key, pr.display_name
       FROM ai_run r
       JOIN ai_run_attribution a ON a.ai_run_id = r.id
       LEFT JOIN provider_registry pr ON pr.id = r.provider_id
      WHERE a.work_card_id = ?1 AND r.status <> 'COMPLETED'
      ORDER BY r.created_at DESC
      LIMIT 1`,
  )
    .bind(cardId)
    .first<{ failure_reason: string | null; provider_key: string | null; display_name: string | null }>();

  const fromRun = readLaneFailure(run?.failure_reason ?? null);
  const failure = isLaneFailure(fromRun) ? fromRun : readLaneFailure(stepDetail);
  if (!isLaneFailure(failure)) return { failure, key: null, name: null, raw: "" };

  // The provider row is the better name ("Anthropic"); the failure text names a key only when the
  // run never reached a provider at all (a missing credential, an everything-is-off refusal).
  const key = run?.provider_key ?? failure.lane ?? null;
  const name = run?.display_name ?? (failure.lane ? titleCase(failure.lane) : null);
  return { failure, key, name, raw: (run?.failure_reason ?? stepDetail ?? "").slice(0, 900) };
}

function titleCase(key: string): string {
  return key
    .split(/[_-]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * A FAILING CARD MUST NOT LOOK LIKE A WAITING CARD — written on every failed attempt, not only at
 * the end.
 *
 * `work_attempts` reached three in silence on 17 Sep because it was counted and never read out.
 * This is the line the Work page shows while the card is still retrying, so the first failure is
 * visible rather than the third.
 */
async function noteFailedAttempt(env: Env, card: SweepCard, line: string, now: Date): Promise<void> {
  await env.WP_OS_DB.prepare("UPDATE work_card SET work_last_failure = ?2, work_last_failure_at = ?3 WHERE id = ?1")
    .bind(card.id, line.slice(0, 400), now.toISOString())
    .run();
}

/** What that line says. Plain, and never the status code. */
function attemptLine(card: SweepCard, failure: LaneFailure, laneName: string | null, allowed: number): string {
  const which = `Attempt ${card.work_attempts} of ${allowed}`;
  if (!isLaneFailure(failure)) return `${which} did not get anywhere.`;
  if (failure.kind === "NO_LANE") return `${which} had nowhere to send the work — every model is switched off or unavailable.`;
  const lane = laneName ? `the ${laneName} lane` : "the lane it tried";
  if (failure.kind === "CREDIT") return `${which} was refused by ${lane} — the account behind it has run out of credit.`;
  if (failure.kind === "CREDENTIAL") return `${which} was refused by ${lane} — the firm is not signed in to it.`;
  if (failure.kind === "RATE_LIMIT") return `${which} was turned away by ${lane} for sending too much at once.`;
  return `${which} was refused by ${lane}.`;
}

async function appendFailureNote(env: Env, cardId: string, detail: string): Promise<void> {
  if (!detail.trim()) return;
  await env.WP_OS_DB.prepare(
    "UPDATE work_card SET description = substr(COALESCE(description, '') || char(10) || '• For an engineer, the last attempt reported: ' || ?2, 1, 16000) WHERE id = ?1",
  )
    .bind(cardId, detail.slice(0, 900))
    .run();
}

export async function sweepOnce(
  env: Env,
  now: Date,
  runners: {
    general?: (env: Env, ctx: RouteContext, cardId: string, options: { maxSteps: number }) => Promise<{ finished: boolean; blocked: boolean; detail: string; steps: Array<{ action: string; detail: string }> }>;
    deckRework?: (env: Env, card: SweepCard) => Promise<{ finished: boolean; blocked: boolean; detail: string }>;
    productions?: (env: Env, card: SweepCard) => Promise<{ finished: boolean; blocked: boolean; detail: string }>;
    productionsHire?: (env: Env, card: SweepCard) => Promise<{ finished: boolean; blocked: boolean; detail: string }>;
    roomPacket?: (env: Env, card: SweepCard) => Promise<{ finished: boolean; blocked: boolean; progressed: boolean; detail: string }>;
    blogHelp?: (env: Env, card: SweepCard) => Promise<{ finished: boolean; blocked: boolean; detail: string }>;
  } = {},
): Promise<SweepResult> {
  await settleAbandonedCards(env, now);
  // NOTHING STAYS STUCK SILENTLY: a block nobody has acted on rings again rather than ageing out.
  await resurfaceStaleBlocks(env, now);
  const card = await claimNextCard(env, now);
  if (!card) {
    return { status: "SUCCEEDED", summary: "nothing waiting: every card an employee owns is done, blocked, or being worked", card: null, outcome: "NOTHING_WAITING" };
  }

  // THE DECK COMES FIRST. If the company's deck is queued and not yet read, this attempt does not
  // count and the card is parked until the reader has had a turn; another card gets this tick.
  const unread = card.kind === "DECK_REWORK" || isProductionsKind(card.kind) || card.kind === "ROOM_PACKET" || card.kind === "BLOG_HELP" ? null : await deckStillBeingRead(env, card.title, card.id);
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
    } else if (card.kind === "ROOM_PACKET") {
      // Parker's Room packet: a CHAIN of research and judgement, one stage per tick. A stage that
      // completed is progress, not a finish — the card is handed back and the next tick continues.
      const run = runners.roomPacket ?? (await import("./roomPacket")).runRoomPacketCard;
      const out = await run(env, card);
      finished = out.finished;
      blocked = out.blocked;
      progressed = out.progressed;
      detail = out.detail;
    } else if (card.kind === "BLOG_HELP") {
      // A partner's blog help: research judged, the piece written in their voice, filed, one email.
      const run = runners.blogHelp ?? (await import("./blogHelp")).runBlogHelpCard;
      const out = await run(env, card);
      finished = out.finished;
      blocked = out.blocked;
      detail = out.detail;
    } else if (card.kind === "PRODUCTIONS_HIRE_SEARCH") {
      // Walker's weekly hire search for West Peek Productions: search, every page checked, judged,
      // remembered across weeks, one deliverable on Scooter's Home, one email to Scooter.
      const run = runners.productionsHire ?? (await import("./productionsHire")).runHireSearchCard;
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
      summary: `"${card.title.slice(0, 60)}" progressed${card.kind === "ROOM_PACKET" ? "" : ` (${STEPS_PER_TICK} step(s) this tick)`}: ${detail.slice(0, 160)}. The next tick continues it.`,
      card: { ...card, work_attempts: Math.max(card.work_attempts - 1, 0) },
      outcome: "PROGRESSED",
    };
  }

  /*
   * ── NEITHER DONE NOR BLOCKED: THE RUN DIED, OR THE EMPLOYEE CHOSE NOTHING USABLE ────────────
   *
   * 17 Sep 2026, and the reason this branch was rewritten. Parker's event-kit card came through
   * here three times in fourteen minutes. Each time the third step had been refused by the direct
   * Anthropic lane — "your credit balance is too low to access the Anthropic API" — and each time
   * this code wrote nothing on the card, said nothing to anybody, and handed it back to the queue.
   * The owner watched it say "Open · queued — picked up within 5 min", three times.
   *
   * Two things are different now, and they are the whole fix:
   *
   *   1. THE ATTEMPT IS WRITTEN DOWN. `work_last_failure` says, in plain words, what refused the
   *      work — from the FIRST failure, not the third. `work_attempts` was already counting; it
   *      was simply never read out anywhere a person looks.
   *   2. HOW MANY GOES IT GETS DEPENDS ON WHAT BROKE. A rate limit or a vendor outage clears
   *      itself, so those keep all three. An empty account does not, and repeating it twice more
   *      buys nothing but fourteen minutes of a card looking healthy.
   */
  const lane = await laneBehindTheFailure(env, card.id, detail);
  const allowed = attemptsAllowedFor(lane.failure, MAX_WORK_ATTEMPTS);
  await noteFailedAttempt(env, card, attemptLine(card, lane.failure, lane.name, allowed), now);

  if (card.work_attempts >= allowed) {
    /*
     * WHAT THE LAST ATTEMPT SAID IS NOT WHAT SHE READS.
     *
     * This line used to paste `detail` — a thrown message from wherever the run died — straight
     * onto the card. Parker's October Workshop therefore said "DISCOVER: the judgement pass failed:
     * the judgement was routed to the search model", which named three internal things and asked
     * her to fix none of them. The failure text is still kept, on the card's own record where an
     * engineer can find it; what the partner reads is a sentence and four buttons.
     */
    await appendFailureNote(env, card.id, detail);
    const who = isProductionsKind(card.kind) ? ("SCOOTER" as const) : ("SEQUOIA" as const);
    const employee = await employeeName(env, card.owner_id);
    /*
     * WHICH BLOCK THIS IS, AND WHY IT MATTERS THAT THEY ARE DIFFERENT.
     *
     * `tried_and_could_not_finish` says "Parker tried three times and could not get this done" and
     * offers her an answer, a rewrite or a drop. Every one of those was the wrong thing to offer on
     * 17 Sep: no answer she could type would have put credit on an account. A lane failure gets its
     * own reason, the lane's own words, and doors that touch the actual fault.
     */
    const why = await blockCard(
      env,
      card,
      isLaneFailure(lane.failure)
        ? {
            reason: lane.failure.kind === "NO_LANE" ? "no_lane_could_take_the_work" : "a_lane_refused_the_work",
            trying: card.title,
            employee,
            who,
            ...(lane.name ? { lane: lane.name } : {}),
            ...(lane.key ? { laneKey: lane.key } : {}),
            laneKind: lane.failure.kind,
            vendorWords: lane.failure.vendorWords,
            raw: lane.raw,
          }
        : { reason: "tried_and_could_not_finish", trying: card.title, employee, who },
      now,
    );
    await announceOutcome(env, card, "BLOCKED", why);
    return { status: "SUCCEEDED", summary: `"${card.title.slice(0, 60)}" blocked after ${card.work_attempts} failed attempt(s) and handed to you: ${detail.slice(0, 140)}`, card, outcome: "BLOCKED" };
  }
  // THE SWEEP RAN; THE CARD IS NOT DONE YET. Reporting this as a failed RUN painted "FAILED" on the
  // Work page for a card that was simply on its first attempt of three (Vantage Robotics, 14 Sep,
  // 13:32). The run succeeded at its job — it worked the card — and the card's own state says the
  // rest. A run fails when the sweep itself could not do its work, not when an employee needs
  // another go.
  return {
    status: "SUCCEEDED",
    summary: `"${card.title.slice(0, 60)}" attempt ${card.work_attempts} of ${allowed} did not finish: ${detail.slice(0, 160)}. It will be tried again.`,
    card,
    outcome: "FAILED",
  };
}
