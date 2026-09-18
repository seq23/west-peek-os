import type { ProviderAdapter, ProviderRequest, ProviderResponse } from "./types";
import type { Env } from "../../env";
import {
  CLAIM_POLL_MS,
  CLAIM_WAIT_MS,
  SEAT_REGISTRY,
  SEAT_UNAVAILABLE,
  abandonRun,
  describeAge,
  laneAvailability,
  parkRun,
  readRun,
  type Seat,
} from "../subscriptionSeats";

/**
 * THE ONE ADAPTER IN THIS DIRECTORY THAT MAKES NO NETWORK CALL — one instance per seat.
 *
 * Every other file here dials a vendor. This one parks a row and waits for a machine to pick it up,
 * because the thing on the other end is a coding agent on the owner's Mac — Claude Code or Codex —
 * and a Cloudflare Worker cannot reach into a laptop. The shape is borrowed from the sister system's `agent_executed`
 * backend — the Worker does not call the Mac; the run waits to be claimed — and nothing is imported
 * from it.
 *
 * IT IS STILL A `ProviderAdapter`, and that is the point rather than a convenience. Being one means
 * the whole of migration 0184's chain applies to it for free: a lane that cannot serve throws, the
 * next lane in the chain runs inside the same `ai_run`, the handover lands in `ai_run_routing`, and
 * the partner's card is answered. There is no second notion of "the Claude Code lane failed"
 * anywhere in this system, and no code path that treats it as special once it has thrown.
 *
 * ── THE THREE WAYS THIS RETURNS ──────────────────────────────────────────────────────────────
 *
 *   1. STALE HEARTBEAT → throws IMMEDIATELY, before anything is written. This is the ordinary case
 *      — the lid is shut — and it costs one indexed read. Nothing is parked, so there is nothing to
 *      clean up and no chance of a machine finding the row an hour later and running it.
 *   2. FRESH, CLAIMED, REPORTED → the answer, at $0.
 *   3. FRESH BUT NOTHING CAME BACK inside `CLAIM_WAIT_MS` → the row is marked ABANDONED so no
 *      claimer will run it after the fact, and it throws. The chain answers the card now.
 *
 * WHY (3) ABANDONS RATHER THAN LEAVING THE ROW FOR LATER. The card is about to be answered on
 * another lane. A claimer that picked the row up afterwards would spend the owner's subscription
 * producing an answer nothing will ever read — and would do it with her interactive capacity. The
 * reaper's "return it to the pool" rule exists for the different case where NO ROUTER IS WAITING:
 * an evicted isolate, a dropped request, a deploy mid-wait. Both paths are real and they are
 * deliberately not the same path.
 */
export interface SubscriptionSeatAdapterOptions {
  env: Env;
  seat: Seat;
  modelAccess: string;
  aiRunId?: string | null;
  workCardId?: string | null;
  aiEmployeeId?: string | null;
  taskClass?: string | null;
  firmScope?: string;
  /** Injected by tests so the wait is not a real ninety seconds. */
  waitMs?: number;
  pollMs?: number;
  /** Injected by tests. Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function createSubscriptionSeatAdapter(opts: SubscriptionSeatAdapterOptions): ProviderAdapter {
  const env = opts.env;
  const seat = opts.seat;
  const waitMs = opts.waitMs ?? CLAIM_WAIT_MS;
  const pollMs = Math.max(1, opts.pollMs ?? CLAIM_POLL_MS);
  const sleep = opts.sleep ?? realSleep;
  const now = opts.now ?? ((): Date => new Date());

  return {
    async complete(req: ProviderRequest): Promise<ProviderResponse> {
      /*
       * A PICTURE OR A DECK IS NOT OFFERED HERE. The claimer hands the model a text instruction
       * over a local pipe; there is no wire format in this design for attachments, and an adapter
       * that silently dropped one would answer confidently about a file the model never saw — the
       * exact failure `types.ts` forbids in as many words. Refused as a CAPABILITY failure, which
       * `isProviderOutage` deliberately does NOT chain: the run already chose a lane that can see.
       */
      if (req.images?.length) throw new Error(`provider_cannot_see_images:${seat}`);
      if (req.documents?.length) throw new Error(`provider_cannot_read_documents:${seat}`);

      // 1. IS THE MACHINE THERE? One read. A stale answer costs the run nothing at all.
      const availability = await laneAvailability(env, seat, now());
      if (!availability.available) {
        throw new Error(`${SEAT_UNAVAILABLE}:${availability.reason}`);
      }

      // 2. PARK IT. Everything upstream — budget, egress, content class, the two labels — has
      //    already run; this row is a leg of a governed `ai_run`, never work of its own.
      const queueId = await parkRun(env, {
        seat,
        purpose: req.purpose,
        prompt: req.inputs.join("\n\n"),
        modelAccess: opts.modelAccess,
        aiRunId: opts.aiRunId ?? null,
        workCardId: opts.workCardId ?? null,
        aiEmployeeId: opts.aiEmployeeId ?? null,
        taskClass: opts.taskClass ?? null,
        firmScope: opts.firmScope ?? "west-peek",
        maxSeconds: Math.round(waitMs / 1000),
      });

      // 3. WAIT, BOUNDED. The deadline is absolute rather than a poll count, so a slow database
      //    read cannot quietly stretch the wait a partner is paying for.
      const deadline = now().getTime() + waitMs;
      for (;;) {
        const row = await readRun(env, queueId);
        if (row && row.status === "REPORTED" && row.output_text) {
          return {
            text: row.output_text,
            model: SEAT_REGISTRY[seat].model,
            /*
             * ZERO, AND THE ZERO IS TRUE. The subscription is a flat fee already paid, so this run
             * moved no money. It is still recorded as a run with usage, because "what did the firm
             * actually get for free this month" is a question the cost centre should be able to
             * answer — an invisible lane looks like a lane nobody uses.
             */
            usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
          };
        }
        if (row && row.status === "FAILED") {
          throw new Error(`subscription_seat_failed:${SEAT_REGISTRY[seat].displayName}: ${row.error ?? "the claimer reported a failure with no reason"}`);
        }
        if (row && row.status === "ABANDONED") {
          // The reaper closed it underneath us. Chain on rather than wait out the deadline.
          throw new Error(`${SEAT_UNAVAILABLE}:${row.resolution ?? "this run was closed while it was waiting"}`);
        }
        const remaining = deadline - now().getTime();
        if (remaining <= 0) break;
        await sleep(Math.min(pollMs, remaining));
      }

      /*
       * NOTHING CAME BACK. Close the row first, THEN throw — in that order, so there is no instant
       * in which the chain is answering the card and a claimer could still pick the row up. If the
       * close loses a race with a report that landed in the same moment, `abandonRun` changes zero
       * rows and the answer is kept; the card is answered twice over, which is wasteful once and
       * never wrong.
       */
      const closed = await abandonRun(
        env,
        queueId,
        `The router waited ${describeAge(waitMs)} and no machine returned an answer, so the work went to the next ` +
          `lane in the chain. This run was closed rather than left for a claimer to find, because its answer would ` +
          `arrive after the card had already been answered.`,
        now(),
      );
      const settled = closed ? "" : " Its answer arrived at the same moment and was kept.";
      throw new Error(
        `${SEAT_UNAVAILABLE}:the ${SEAT_REGISTRY[seat].displayName} seat was awake but returned nothing within ${describeAge(waitMs)}, ` +
          `so the run moved on to a lane that answers over the network.${settled}`,
      );
    },
  };
}
