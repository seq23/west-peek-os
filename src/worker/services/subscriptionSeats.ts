import { z } from "zod";
import type { RouteContext } from "../router";
import { json } from "../router";
import { SUBSCRIPTION_CLAIMER_EMAIL } from "../auth";
import {
  HEARTBEAT_FRESH_MS,
  HEARTBEAT_INTERVAL_S,
  SEATS,
  allSeatAvailability,
  claimRun,
  isSeat,
  recordHeartbeat,
  reportRun,
  type Seat,
} from "../ai/subscriptionSeats";

/**
 * THE THREE ROUTES THE CLAIMER ON HER MAC SPEAKS, AND NOTHING ELSE.
 *
 *   POST /api/subscription-seats/heartbeat   "These seats are awake."  → availability
 *   POST /api/subscription-seats/claim       "Give me one."            → a parked run, or nothing
 *   POST /api/subscription-seats/report      "Here is the answer."     → terminal
 *   GET  /api/subscription-seats/status      "Why did this cost money?"
 *
 * SEAT-SCOPED THROUGHOUT. One claimer process may serve `claude_code`, `codex`, or both, and it
 * says which on every call. A machine that only has one of them installed never sees the other's
 * work, and a seat that dies takes only itself down.
 *
 * WHAT IS DELIBERATELY ABSENT: any route that CREATES work. The claimer cannot ask the firm to
 * think about something; it can only take work the router already parked, which was authorised,
 * budgeted, classified and egress-checked as somebody else's run before it existed. An agent on a
 * laptop must not be able to widen what this system does.
 *
 * ── AUTHENTICATION ───────────────────────────────────────────────────────────────────────────
 *
 * The same Cloudflare Access service token the read-only browser agent uses, with its own client
 * id and its own firm identity — see auth.ts. Access verifies the token before the request reaches
 * this Worker, so there is no shared secret in this repo and no new mechanism to get wrong.
 *
 * A MANAGING PARTNER MAY ALSO CALL THESE, and that is not a convenience. The owner drives her
 * systems from a terminal; a lane she cannot poke by hand is a lane she cannot diagnose when it is
 * quiet. Everyone else gets 403 — not because the data is dangerous, but because a route that
 * hands out a partner's instruction text should answer a precise question about who is asking.
 */

const MANAGING_PARTNER_ROLE = "MANAGING_PARTNER";

/** Who may speak for the lane: the claimer itself, or a partner at a keyboard. */
function mayClaim(ctx: RouteContext): boolean {
  const identity = ctx.identity;
  if (!identity) return false;
  if (identity.email.toLowerCase() === SUBSCRIPTION_CLAIMER_EMAIL) return true;
  return identity.roles.includes(MANAGING_PARTNER_ROLE);
}

const forbidden = (): Response =>
  json(
    {
      error: "forbidden",
      detail:
        "These routes belong to the subscription-seat claimer on the firm's own machine. They are reachable " +
        "by that agent's Access service token, or by a Managing Partner.",
    },
    { status: 403 },
  );

const seatSchema = z
  .string()
  .trim()
  .refine(isSeat, { message: `seat must be one of: ${SEATS.join(", ")}` });

const heartbeatSchema = z.object({
  device_id: z.string().trim().min(1).max(200),
  /*
   * A LIST, because one process serves both seats and pinging twice would be two round trips to
   * say one thing. An empty list is refused rather than treated as "all": a claimer that forgot to
   * say what it can run must not silently be offered work it cannot do.
   */
  seats: z.array(seatSchema).min(1).max(SEATS.length),
  hostname: z.string().trim().max(200).optional(),
  agent_version: z.string().trim().max(60).optional(),
  capabilities: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
});

/**
 * "I AM AWAKE." The whole availability mechanism, and it is one upsert.
 *
 * The response tells the claimer how often to ping and how long the firm will consider it fresh, so
 * the two halves cannot drift apart: a claimer shipped with a five-minute interval against a
 * two-minute window would be permanently invisible and nothing would say why. Read from the same
 * constants the router reads.
 */
export async function handleSubscriptionSeatHeartbeat(ctx: RouteContext): Promise<Response> {
  if (!mayClaim(ctx)) return forbidden();
  const parsed = heartbeatSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_input", detail: parsed.error.issues[0]?.message }, { status: 400 });

  for (const seat of parsed.data.seats as Seat[]) {
    await recordHeartbeat(ctx.env, {
      seat,
      deviceId: parsed.data.device_id,
      hostname: parsed.data.hostname ?? null,
      agentVersion: parsed.data.agent_version ?? null,
      ...(parsed.data.capabilities ? { capabilities: parsed.data.capabilities } : {}),
    });
  }

  return json({
    ok: true,
    seats: parsed.data.seats,
    heartbeat_interval_seconds: HEARTBEAT_INTERVAL_S,
    freshness_window_seconds: Math.round(HEARTBEAT_FRESH_MS / 1000),
  });
}

const claimSchema = z.object({
  device_id: z.string().trim().min(1).max(200),
  /** Only the seats this machine can actually run. See `claimRun`. */
  seats: z.array(seatSchema).min(1).max(SEATS.length),
});

/**
 * "GIVE ME ONE." Returns a run or an explicit nothing — never an error for an empty queue.
 *
 * AN EMPTY QUEUE IS THE NORMAL ANSWER and must look like one, because a claimer that treats it as a
 * failure will back off, log noise, or stop. Most of the firm's work is PUBLIC_MODEL_APPROVED and
 * never comes here at all; this lane is quiet by design.
 *
 * THE HEARTBEAT IS WRITTEN HERE TOO. A claimer asking for work has just proved it is awake, and
 * relying on the separate ping alone would mean a device that polls every second could still read
 * as stale if one heartbeat request were dropped.
 */
export async function handleSubscriptionSeatClaim(ctx: RouteContext): Promise<Response> {
  if (!mayClaim(ctx)) return forbidden();
  const parsed = claimSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_input", detail: parsed.error.issues[0]?.message }, { status: 400 });

  const seats = parsed.data.seats as Seat[];
  for (const seat of seats) await recordHeartbeat(ctx.env, { seat, deviceId: parsed.data.device_id });
  const run = await claimRun(ctx.env, parsed.data.device_id, seats);
  if (!run) return json({ run: null, detail: "nothing parked" });

  return json({
    run: {
      id: run.id,
      seat: run.seat,
      purpose: run.purpose,
      prompt: run.prompt,
      model_access: run.model_access,
      max_seconds: run.max_seconds,
      attempt_count: run.attempt_count,
      /*
       * SAID ON EVERY RUN, not documented once. This work carries LP names, deal terms or fund
       * figures. It may be answered by Claude Code on this machine — the subscription's terms
       * forbid training on it — and it may not be pasted anywhere else, written to a shared
       * location, or handed to another tool.
       */
      handling:
        "Private model only. Answer this on this machine with the seat named above and report the answer back. " +
        "Do not send it anywhere else, do not write it to disk outside the run, and do not paste it into another tool.",
    },
  });
}

const reportSchema = z
  .object({
    device_id: z.string().trim().min(1).max(200),
    run_id: z.string().trim().min(1).max(200),
    output_text: z.string().max(400_000).optional(),
    error: z.string().trim().max(2_000).optional(),
  })
  .refine((v) => (v.output_text && v.output_text.length > 0) || (v.error && v.error.length > 0), {
    message: "report either output_text or error — a report that says neither tells the router nothing",
  });

/**
 * "HERE IS THE ANSWER", or "I could not."
 *
 * EITHER IS A RESULT. A claimer that hits an error and says so lets the chain move on inside the
 * same run; a claimer that says nothing leaves the row for the reaper and the partner waits out the
 * router's ninety seconds for no reason. So the failure path is a first-class report, not an
 * exception, and the schema refuses a report that carries neither.
 *
 * A REJECTED REPORT IS ANSWERED WITH A REASON, not a 409 and a shrug: the usual cause is a machine
 * coming back from sleep to find its run was returned to the pool and answered elsewhere, which is
 * the system working correctly and something the claimer should log calmly rather than retry.
 */
export async function handleSubscriptionSeatReport(ctx: RouteContext): Promise<Response> {
  if (!mayClaim(ctx)) return forbidden();
  const parsed = reportSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_input", detail: parsed.error.issues[0]?.message }, { status: 400 });

  const result = await reportRun(ctx.env, {
    runId: parsed.data.run_id,
    deviceId: parsed.data.device_id,
    outputText: parsed.data.output_text ?? null,
    error: parsed.data.error ?? null,
  });
  if (!result.accepted) return json({ accepted: false, detail: result.detail }, { status: 409 });
  return json({ accepted: true, detail: result.detail });
}

/**
 * IS THE LANE THERE? The same question the router asks, answerable by a person.
 *
 * Exists because "why did this card cost money" is the question the owner will actually ask, and
 * the honest answer is usually "your laptop was shut". A page that can say so beats reading run
 * explanations one at a time.
 */
export async function handleSubscriptionSeatStatus(ctx: RouteContext): Promise<Response> {
  if (!mayClaim(ctx)) return forbidden();
  const availability = await allSeatAvailability(ctx.env);
  const queued = await ctx.env.WP_OS_DB.prepare(
    `SELECT seat, status, COUNT(*) AS n FROM subscription_seat_run GROUP BY seat, status`,
  ).all<{ seat: string; status: string; n: number }>();
  return json({
    heartbeat_interval_seconds: HEARTBEAT_INTERVAL_S,
    freshness_window_seconds: Math.round(HEARTBEAT_FRESH_MS / 1000),
    /*
     * ANY seat awake means the firm has free frontier capacity right now. Reported as its own field
     * because that — not "are both up" — is the question the ladder actually asks.
     */
    any_seat_available: availability.some((a) => a.available),
    seats: availability.map((a) => ({
      seat: a.seat,
      available: a.available,
      reason: a.reason,
      device_id: a.deviceId,
      last_seen_at: a.lastSeenAt,
      queue: Object.fromEntries((queued.results ?? []).filter((r) => r.seat === a.seat).map((r) => [r.status, r.n])),
    })),
  });
}
