import type { Env } from "../env";
import type { RouteContext } from "../router";
import { json } from "../router";
import { appendEvent } from "../events";
import type { Actor } from "./authorize";
import { PREVIEW_ENV_KEY, type PreviewEnvMarker } from "../effects/emailTransport";
import {
  CARD_OPENING_JOB_KEYS,
  PREVIEW_COST_NOTICE,
  PREVIEW_RECIPIENT,
  type PreviewCardShape,
  type PreviewContext,
} from "../../shared/work/preview";
import { isPartnerFirmUserId, partnerByFirmUserId } from "../../shared/registry/partners";
import type { SweepCard } from "./workSweep";
import { isoWeekOf } from "./jobs";

/**
 * RUNNING A JOB OR A CARD FOR REAL WITHOUT LETTING IT LAND (17 Sep 2026).
 *
 * The contract, the five properties and the reasoning are in `shared/work/preview.ts`. This file is
 * the half that needs a database and an identity: it builds the environment a preview runs inside,
 * works out what to run, runs it, and reports what came out.
 *
 * ─── THE WRITE BLOCK, AND WHY IT IS A HANDLE RATHER THAN A HABIT ───────────────────────────────
 *
 * "It must not consume the real run" is the property with the most ways to get it wrong, because
 * every stage of every chain writes something: a card moves, a candidate is remembered, a
 * deliverable is filed, a notice is raised, an event is appended. Asking each of them to check a
 * flag is the convention that fails on the next stage somebody adds.
 *
 * So a preview does not get `env.WP_OS_DB`. It gets a handle that answers every READ for real —
 * which is what makes the run honest, because the search really does check this week's candidates
 * against the rows the real weeks wrote — and performs NO WRITE except to the tables that record
 * what a model call cost. Every suppressed write is recorded, so the preview can say what would
 * have happened rather than merely not doing it.
 *
 * ─── THE ONE DELIBERATE EXCEPTION: MONEY ───────────────────────────────────────────────────────
 *
 * Operator: "It costs money and counts against the caps. A real run is a real run; do not exempt
 * it." So `ai_run` and its accounting siblings are WRITABLE in a preview. The call is budgeted
 * before it happens, priced after it, attributed to the employee who made it and counted against
 * the firm's daily cap — identically to Monday's run. A preview that ran free would be a preview
 * whose cost she discovers at the end of the month.
 */

/** Tables a preview may write. Everything else is suppressed. See the note above. */
export const PREVIEW_WRITABLE_TABLES: readonly string[] = [
  // The run itself: status, model, token usage, cost estimate, failure reason.
  "ai_run",
  // Which candidates were considered and which was chosen, and why.
  "ai_run_routing",
  // Whose budget the spend belongs to.
  "ai_run_attribution",
  // What this model actually did on this kind of job, which is how routing learns.
  "model_job_outcome",
  // A cap crossed during a preview is a cap crossed. Silencing it would make a preview the one way
  // to spend past a limit without anybody being told.
  "cost_alert",
];

const WRITE_VERB = /^\s*(?:with\b[\s\S]*?\b)?(insert|update|delete|replace|create|drop|alter)\b/i;
const TABLE_OF =
  /^\s*(?:insert\s+(?:or\s+\w+\s+)?into|update|delete\s+from|replace\s+into)\s+["'`[]?([a-z_][a-z0-9_]*)/i;

/** A suppressed write, kept so the preview can report what the real run would have changed. */
export interface SuppressedWrite {
  table: string;
  verb: string;
}

interface PreviewDbState {
  suppressed: SuppressedWrite[];
}

/**
 * A no-op statement. Shaped exactly like D1's, so a caller cannot tell it apart except by the fact
 * that nothing changed: `run()` reports zero rows changed (honest — nothing was), `first()` is
 * null, `all()` is empty.
 */
function suppressedStatement(): D1PreparedStatement {
  const empty = {
    success: true,
    results: [],
    meta: { changes: 0, last_row_id: 0, duration: 0, rows_read: 0, rows_written: 0 },
  };
  const stmt = {
    bind: () => stmt,
    first: async () => null,
    run: async () => empty,
    all: async () => empty,
    raw: async () => [],
  };
  return stmt as unknown as D1PreparedStatement;
}

/**
 * The database handle a preview runs against: every read real, every write suppressed unless the
 * table is one of the accounting tables above.
 *
 * DECIDED FROM THE SQL, not from the caller. A guard that trusts its callers to declare what they
 * are doing is the convention this exists to replace; the statement itself says whether it writes.
 * Anything this cannot classify as a read is treated as a write and suppressed — the safe direction,
 * because the failure mode of being wrong is "the preview showed less", not "the preview changed
 * production".
 */
export function previewDb(real: D1Database, state: PreviewDbState): D1Database {
  const writable = new Set(PREVIEW_WRITABLE_TABLES);
  return {
    ...real,
    prepare(query: string): D1PreparedStatement {
      const verb = WRITE_VERB.exec(query)?.[1]?.toLowerCase();
      if (!verb) return real.prepare(query);
      const table = TABLE_OF.exec(query)?.[1]?.toLowerCase() ?? "(unknown)";
      if (writable.has(table)) return real.prepare(query);
      state.suppressed.push({ table, verb });
      return suppressedStatement();
    },
    /*
     * A BATCH IS A WRITE PATH TOO. Statements reaching it have already been through `prepare`, so a
     * suppressed one is already inert; passing the batch straight through would run only the
     * accounting statements, which is exactly the intended behaviour. It is named here so the next
     * reader does not have to work that out.
     */
    batch: real.batch.bind(real),
    /*
     * `exec` takes raw SQL and bypasses `prepare` entirely. Nothing in this codebase calls it on a
     * request path — it exists for migrations — so a preview refuses rather than guessing.
     */
    exec: async () => {
      throw new Error("a preview may not run raw SQL through exec(); it cannot be checked for writes");
    },
  } as unknown as D1Database;
}

/**
 * The environment a preview runs inside: the same bindings, a guarded database, and the marker the
 * send boundary reads.
 *
 * A SHALLOW COPY, NEVER A MUTATION of the real `env`. A Worker isolate serves many requests from
 * one `env` object; setting the marker on it would put an unrelated live send into preview mode, or
 * — far worse — leave preview mode on after this request finished.
 */
export function previewEnv(env: Env, ctx: PreviewContext): { env: Env; suppressed: SuppressedWrite[] } {
  const state: PreviewDbState = { suppressed: [] };
  const marker: PreviewEnvMarker = { id: ctx.id, what: ctx.what, requestedByEmail: ctx.requestedByEmail };
  const previewed = {
    ...env,
    WP_OS_DB: previewDb(env.WP_OS_DB, state),
    [PREVIEW_ENV_KEY]: marker,
  } as unknown as Env;
  return { env: previewed, suppressed: state.suppressed };
}

// ── What a job's card looks like, so a preview can run it without opening one ──────────────────

/**
 * See `PreviewCardShape` in `shared/work/preview.ts` for why a preview synthesises the card instead
 * of calling the job's opener: the opener reads its own INSERT back (which the write block cannot
 * answer), and opening the card for real would put a live card on the employee's desk that the real
 * sweep then works — the preview would consume the very run it exists not to consume.
 *
 * `validate:preview` fails the build if a card-opening job key is missing from this table.
 */
export const PREVIEW_JOB_CARDS: Readonly<Record<string, PreviewCardShape>> = {
  productions_hire_search: {
    cardKind: "PRODUCTIONS_HIRE_SEARCH",
    ownerId: "aie_walker",
    what: "Walker's weekly hire search for West Peek Productions — Scooter's own agency, not the fund",
    title: (now) => `Walker: West Peek Productions hire search (${isoWeekOf(now)})`,
  },
  productions_monthly: {
    cardKind: "PRODUCTIONS_MONTHLY",
    ownerId: "aie_walker",
    what: "Walker's monthly note for West Peek Productions — customers to approach and press pitches",
    title: (now) => `Walker: West Peek Productions (${now.toISOString().slice(0, 7)})`,
  },
  productions_customer_ideas: {
    cardKind: "PRODUCTIONS_CUSTOMERS",
    ownerId: "aie_walker",
    what: "Walker's customer search for West Peek Productions (folded into the monthly note)",
    title: (now) => `Walker: West Peek Productions customers (${now.toISOString().slice(0, 7)})`,
  },
  productions_press_pitches: {
    cardKind: "PRODUCTIONS_PRESS",
    ownerId: "aie_walker",
    what: "Walker's press pitches for West Peek Productions (folded into the monthly note)",
    title: (now) => `Walker: West Peek Productions press (${now.toISOString().slice(0, 7)})`,
  },
};

/** Every job key that opens a card, so the validator can check this table covers all of them. */
export const PREVIEWABLE_CARD_JOBS: readonly string[] = CARD_OPENING_JOB_KEYS;

// ── Running one ───────────────────────────────────────────────────────────────────────────────

export interface PreviewOutcome {
  id: string;
  what: string;
  /** The card that was run — real, for a CARD target; synthesised, for a JOB target. */
  card: SweepCard;
  /** Whether the work reached a conclusion, the same three answers the sweep gets. */
  finished: boolean;
  blocked: boolean;
  detail: string;
  /** Where the preview went, always. */
  sentTo: string;
  /** What the real run would have changed and this one did not. */
  suppressed: SuppressedWrite[];
  costNotice: string;
}

/** The runner for a card kind — the sweep's own dispatch, reached without importing the sweep. */
async function runnerFor(
  kind: string | null,
): Promise<((env: Env, card: SweepCard) => Promise<{ finished: boolean; blocked: boolean; detail: string }>) | null> {
  if (kind === "PRODUCTIONS_HIRE_SEARCH") return (await import("./productionsHire")).runHireSearchCard;
  if (kind === "DECK_REWORK") return (await import("./deck")).runDeckRework;
  if (kind === "ROOM_PACKET") return (await import("./roomPacket")).runRoomPacketCard;
  if (kind === "BLOG_HELP") return (await import("./blogHelp")).runBlogHelpCard;
  if (kind === "PRODUCTIONS_CUSTOMERS" || kind === "PRODUCTIONS_PRESS" || kind === "PRODUCTIONS_MONTHLY") {
    return (await import("./productions")).runProductionsCard;
  }
  return null;
}

export class PreviewError extends Error {
  constructor(
    public status: number,
    public code: string,
    detail?: string,
  ) {
    super(detail ?? code);
  }
}

/**
 * Run one preview, end to end.
 *
 * The employee is the real employee, the prompts are the real prompts, the searches are real and
 * the note is the one that would have been sent. What differs is the handle it writes through and
 * the address it goes to, and both of those are decided here and enforced somewhere the work cannot
 * reach.
 */
export async function runPreview(
  env: Env,
  requester: { id: string; email: string },
  request: { kind: "JOB" | "CARD"; key: string },
  now = new Date(),
): Promise<PreviewOutcome> {
  if (!isPartnerFirmUserId(requester.id)) {
    // A 404 rather than a 403: previews are not a thing that exists for anyone else.
    throw new PreviewError(404, "not_found");
  }

  let card: SweepCard;
  let what: string;

  if (request.kind === "CARD") {
    const row = await env.WP_OS_DB.prepare(
      `SELECT id, title, kind, owner_id, state, COALESCE(work_attempts, 0) AS work_attempts, firm_scope, requested_by_email
         FROM work_card WHERE id = ?1`,
    )
      .bind(request.key)
      .first<SweepCard>();
    if (!row) throw new PreviewError(404, "not_found", "no work card with that id");
    card = row;
    what = `${row.title} (${row.kind ?? "general work"})`;
  } else {
    const shape = PREVIEW_JOB_CARDS[request.key];
    if (!shape) {
      throw new PreviewError(
        400,
        "not_previewable",
        `${request.key} does not open a work card, so there is no deliverable to preview. Run it with "Run it now" instead.`,
      );
    }
    what = shape.what;
    /*
     * A CARD ID THAT IS NOT IN THE DATABASE, ON PURPOSE. Nothing may write, so nothing would find
     * it anyway; and an id that cannot collide with a real card means no preview can be mistaken
     * for one. `steerFor` reads notes by card id and finds none, which is correct: a card that has
     * not been opened yet carries nothing anybody has typed on it.
     */
    card = {
      id: `wc_preview_${crypto.randomUUID()}`,
      title: shape.title(now),
      kind: shape.cardKind,
      owner_id: shape.ownerId,
      state: "IN_PROGRESS",
      work_attempts: 1,
      firm_scope: "west-peek",
      requested_by_email: null,
    };
  }

  const ctx: PreviewContext = {
    id: `prv_${crypto.randomUUID()}`,
    requestedBy: requester.id,
    requestedByEmail: requester.email,
    target: request,
    what,
    startedAt: now.toISOString(),
  };

  const run = await runnerFor(card.kind);
  if (!run) {
    throw new PreviewError(
      400,
      "not_previewable",
      `${card.kind ?? "this card"} has no chain of its own; it is worked by the general employee loop, which cannot be run without moving the card.`,
    );
  }

  /*
   * THE EVENT IS APPENDED THROUGH THE REAL HANDLE, BEFORE AND AFTER — and this is the one thing a
   * preview deliberately does write outside the accounting tables. Rule 0: a stage that records
   * nothing when it runs is indistinguishable from one that never ran, and "what has been previewed,
   * by whom, and what did it cost" has to be answerable from the spine like everything else.
   */
  await appendEvent(env, {
    eventType: "preview.started",
    actorType: "firm_user",
    actorId: requester.id,
    objectType: request.kind === "CARD" ? "work_card" : "scheduled_job",
    objectId: request.key,
    firmScope: card.firm_scope,
    payload: { preview_id: ctx.id, what, card_kind: card.kind, sent_to: PREVIEW_RECIPIENT },
  });

  const { env: previewed, suppressed } = previewEnv(env, ctx);
  let outcome: { finished: boolean; blocked: boolean; detail: string };
  try {
    outcome = await run(previewed, card);
  } catch (err) {
    outcome = { finished: false, blocked: true, detail: err instanceof Error ? err.message : String(err) };
  }

  await appendEvent(env, {
    eventType: "preview.finished",
    actorType: "firm_user",
    actorId: requester.id,
    objectType: request.kind === "CARD" ? "work_card" : "scheduled_job",
    objectId: request.key,
    firmScope: card.firm_scope,
    payload: {
      preview_id: ctx.id,
      finished: outcome.finished,
      blocked: outcome.blocked,
      detail: outcome.detail.slice(0, 900),
      sent_to: PREVIEW_RECIPIENT,
      // What the scheduled run will change and this one did not.
      not_written: [...new Set(suppressed.map((s) => s.table))],
    },
  });

  return {
    id: ctx.id,
    what,
    card,
    finished: outcome.finished,
    blocked: outcome.blocked,
    detail: outcome.detail,
    sentTo: PREVIEW_RECIPIENT,
    suppressed,
    costNotice: PREVIEW_COST_NOTICE,
  };
}

/**
 * POST /api/preview { kind: "JOB" | "CARD", key }
 *
 * ONLY A PARTNER, and a 404 for anybody else — the same shape the productions candidate routes use.
 * A preview does the real work and spends the firm's money, so it is not a read-only surface with a
 * different name.
 */
export async function handleRunPreview(ctx: RouteContext): Promise<Response> {
  const identity = ctx.identity;
  if (!identity || !isPartnerFirmUserId(identity.id)) return json({ error: "not_found" }, { status: 404 });

  let body: { kind?: unknown; key?: unknown } = {};
  try {
    body = (await ctx.request.json()) as { kind?: unknown; key?: unknown };
  } catch {
    body = {};
  }
  const kind = body.kind === "CARD" ? "CARD" : body.kind === "JOB" ? "JOB" : null;
  const key = typeof body.key === "string" ? body.key.trim() : "";
  if (!kind || !key) {
    return json({ error: "invalid_input", detail: 'send { "kind": "JOB" | "CARD", "key": "…" }' }, { status: 400 });
  }

  const partner = partnerByFirmUserId(identity.id)!;
  try {
    const outcome = await runPreview(ctx.env, { id: partner.firmUserId, email: partner.email }, { kind, key });
    return json({
      preview: {
        id: outcome.id,
        what: outcome.what,
        finished: outcome.finished,
        blocked: outcome.blocked,
        detail: outcome.detail,
        sent_to: outcome.sentTo,
        cost_notice: outcome.costNotice,
        not_written: [...new Set(outcome.suppressed.map((s) => s.table))],
      },
    });
  } catch (err) {
    if (err instanceof PreviewError) return json({ error: err.code, detail: err.message }, { status: err.status });
    throw err;
  }
}

/** Used by the actor a preview runs as; exported so tests can build one without the route. */
export function previewActor(firmUserId: string, firmScope = "west-peek"): Actor {
  return { type: "HUMAN", firmUserId, roles: ["MANAGING_PARTNER"], firmScopes: [firmScope] };
}
