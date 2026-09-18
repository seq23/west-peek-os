import { z } from "zod";
import type { Env } from "../env";
import type { FirmUserIdentity } from "../auth";
import type { RouteContext } from "../router";
import { json } from "../router";
import { appendEvent } from "../events";
import { privacyLabelSchema, DEFAULT_PRIVACY_LABEL } from "../../shared/privacy";
import { actorFromIdentity, authorize, canAccessPrivacyLabel, privacyVisibilityClause } from "./authorize";
import { getVisibleCapture } from "./captures";
import { blockOf } from "./blocks";
import { RECORD_GROUP_COLUMNS, RECORD_GROUP_SQL, RECORD_STATES, monthLabel, type RecordState } from "../../shared/work/record";

/**
 * Work spine (P3): the unit of governed work. State transitions are enforced
 * here; every material mutation appends to the event spine (D15).
 */

export interface WorkCardRow {
  id: string;
  capture_id: string | null;
  title: string;
  description: string | null;
  domain_id: string | null;
  machine_id: number | null;
  owner_type: string;
  owner_id: string | null;
  state: string;
  priority: string;
  privacy_label: string;
  /**
   * THE TWO LABELS THE OWNER ASKED FOR, and they are two because one column answering both
   * questions is what sent a hire search to the dearest model on the account.
   *
   *   model_access → WHICH MODELS MAY SEE IT. PUBLIC_MODEL_APPROVED (default) or
   *                   PRIVATE_MODEL_ONLY: LP names, deal terms, fund figures, diligence.
   *   audience     → PREVIEW AND APPROVAL. External is anyone but sequoia@ or scooter@.
   *
   * Neither is derived from the other: an LP memo for Sequoia is PRIVATE_MODEL_ONLY AND internal;
   * an event kit for a guest is PUBLIC_MODEL_APPROVED AND external.
   */
  model_access: string;
  audience: string;
  firm_scope: string;
  next_action: string | null;
  due_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export const WORK_CARD_STATES = ["OPEN", "IN_PROGRESS", "BLOCKED", "DONE", "CANCELLED"] as const;
export type WorkCardState = (typeof WORK_CARD_STATES)[number];

/**
 * Which moves are legal.
 *
 * TWO RULES, AND THE SECOND ONE IS WHY THIS TABLE WAS WRONG. First: nothing is deleted, so every
 * terminal state can be walked back — a card is a record of what the firm decided, and a decision
 * gets revisited. Second, and the one that actually bit: **this table must permit every move the
 * interface offers.** It did not. `CANCELLED` allowed nothing at all while the page rendered a
 * "Put it back" button on exactly those cards, and `OPEN` did not allow `DONE` while every open
 * card rendered a "Done" button. Both 409'd. The card sat there, the operator pressed the button,
 * and nothing happened — the failure was a one-line notice under a legend most of the way up the
 * page.
 *
 * Walking back always lands on OPEN rather than on whatever the card was before. What it was is
 * history; what it is now is undecided, and reconstructing a prior state would be inventing one.
 *
 * `tests/work-cards.test.ts` asserts this table against the moves the page can offer, so the two
 * cannot drift apart again in silence.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<WorkCardState, readonly WorkCardState[]>> = {
  OPEN: ["IN_PROGRESS", "BLOCKED", "DONE", "CANCELLED"],
  IN_PROGRESS: ["OPEN", "BLOCKED", "DONE", "CANCELLED"],
  BLOCKED: ["OPEN", "IN_PROGRESS", "DONE", "CANCELLED"],
  DONE: ["OPEN"], // reopened
  CANCELLED: ["OPEN"], // put back — the decision not to act was revisited
};

/** Whether a move is legal. The single reader of the table above, so nothing consults it twice. */
export function canTransition(from: WorkCardState, to: WorkCardState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/**
 * The moves the Work page can put in front of somebody, as a function of the card's state.
 *
 * Kept beside the table it has to agree with, and exported so a test can hold them together. This
 * is the honest shape of the coupling: the page decides which buttons exist, the server decides
 * which moves are legal, and there is no reason for those two to be discovered as different at
 * runtime by an operator pressing a button.
 */
export function offeredMoves(state: WorkCardState): readonly WorkCardState[] {
  // A finished or dropped card is out of the live board and offers exactly one move: back to open.
  // Everything else is live and offers the working moves.
  if (state === "DONE" || state === "CANCELLED") return ["OPEN"];
  const out: WorkCardState[] = ["DONE", "CANCELLED"];
  if (state === "OPEN") out.unshift("IN_PROGRESS");
  return out;
}

export class WorkCardError extends Error {
  constructor(
    public status: number,
    public code: string,
    detail?: string,
  ) {
    super(detail ?? code);
  }
}

const createWorkCardSchema = z.object({
  capture_id: z.string().min(1).optional(),
  title: z.string().trim().min(1),
  description: z.string().optional(),
  domain_id: z.string().trim().min(1).optional(),
  machine_id: z.number().int().positive().optional(),
  owner_type: z.enum(["HUMAN", "AI", "UNASSIGNED"]).optional(),
  owner_id: z.string().trim().min(1).optional(),
  priority: z.string().trim().min(1).optional(),
  /** Optional instruction for whoever works it. */
  prompt: z.string().max(4000).optional(),
  privacy_label: privacyLabelSchema.optional(),
  /*
   * DEFAULTS ARE THE DESIGN HERE, not a convenience. "MOST WORK IS INTERNAL AND NOT-CONFIDENTIAL SO
   * CAN USE FREE TRAINING MODELS WITH REASONING AND CLOSE TO $0." If the common case needed a
   * deliberate tick it would go unticked, the free lanes would stay unused, and the bill would not
   * move — which is exactly the state this change exists to leave behind.
   */
  model_access: z.enum(["PUBLIC_MODEL_APPROVED", "PRIVATE_MODEL_ONLY"]).default("PUBLIC_MODEL_APPROVED"),
  audience: z.enum(["INTERNAL", "EXTERNAL"]).default("INTERNAL"),
  next_action: z.string().optional(),
  due_at: z.string().trim().min(1).optional(),
});

const updateWorkCardSchema = z
  .object({
    state: z.enum(WORK_CARD_STATES).optional(),
    title: z.string().trim().min(1).optional(),
    description: z.string().nullable().optional(),
    owner_type: z.enum(["HUMAN", "AI", "UNASSIGNED"]).optional(),
    owner_id: z.string().trim().min(1).nullable().optional(),
    priority: z.string().trim().min(1).optional(),
    next_action: z.string().nullable().optional(),
    prompt: z.string().max(4000).nullable().optional(),
    due_at: z.string().trim().min(1).nullable().optional(),
  })
  .strict();

async function parseJsonBody(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function firmScopesOf(identity: FirmUserIdentity): string[] {
  const scopes = identity.authorityScopes.filter((s) => s.scopeKey === "firm_scope").map((s) => s.scopeValue);
  return scopes.length > 0 ? scopes : ["west-peek"];
}

async function getVisibleWorkCard(env: Env, identity: FirmUserIdentity, id: string): Promise<WorkCardRow | null> {
  const row = await env.WP_OS_DB.prepare("SELECT * FROM work_card WHERE id = ?1").bind(id).first<WorkCardRow>();
  if (!row) return null;
  if (!firmScopesOf(identity).includes(row.firm_scope)) return null;
  if (!canAccessPrivacyLabel(identity, row.privacy_label)) return null;
  return row;
}

export interface CreateWorkCardInput {
  capture_id?: string;
  title: string;
  description?: string;
  domain_id?: string;
  machine_id?: number;
  owner_type?: "HUMAN" | "AI" | "UNASSIGNED";
  owner_id?: string;
  priority?: string;
  privacy_label?: string;
  model_access?: "PUBLIC_MODEL_APPROVED" | "PRIVATE_MODEL_ONLY";
  audience?: "INTERNAL" | "EXTERNAL";
  firm_scope?: string;
  next_action?: string;
  due_at?: string;
  /** Optional instruction for whoever works it — how to do it, not what it is. */
  prompt?: string;
}

/** Shared creation path (HTTP handler and capture routing). Authorizes internally. */
/**
 * How many cards one employee may open before the firm treats it as a malfunction.
 *
 * NOT A PERMISSION — a health signal. Decided 22 Aug 2026; reasoning in
 * `docs/APPROVAL_AND_WORK_DESIGN.md`. An employee opening forty cards in an hour is not exercising
 * judgement the partners need to review, it is looping, and the right answer is to stop that
 * employee and tell them — not to queue forty approvals, which delivers the flood to the partners
 * instead of stopping it.
 *
 * THE NUMBERS ARE NOT DELICATE, which is the point of choosing them this way. A working employee on
 * a real queue opens something like five to fifteen cards a day; a loop produces hundreds in an
 * hour. The gap is two orders of magnitude, so the threshold does not need tuning — it needs to sit
 * in the canyon between the two. Twenty in an hour is roughly a day's honest work arriving at once,
 * which is the earliest point at which "this is not normal" is certainly true.
 */
export const CARDS_PER_HOUR_TRIP = 20;

/** Nobody works sixty things. A standing ceiling, independent of rate. */
export const OPEN_CARDS_CEILING = 60;

/** The states in which a card is still somebody's problem. */
const LIVE_STATES = "('OPEN','IN_PROGRESS','BLOCKED')";

/**
 * The card this one would duplicate, if there is one.
 *
 * A CORRECTNESS RULE, ALWAYS ON, NOT A THRESHOLD. The same employee opening the same card twice is
 * never intended: it is a retry, a re-read of the same inbox, or a job that ran twice. So this is
 * uniqueness rather than volume — at most one live card per (machine, object, owner).
 *
 * Deliberately NOT a UNIQUE index. The caller must be able to JOIN the existing card rather than
 * fail: an employee told "denied, duplicate" will reword the title and file it anyway, which turns a
 * clean duplicate into a dirty one. A constraint could only refuse.
 *
 * THE OBJECT IS THE THIRD TERM AND IT WAS MISSING. The rule above says (machine, object, owner); the
 * query matched only (machine, owner), which is a different and much larger claim — "this employee
 * may hold one live card per machine". Deal intake found it the hard way: Wyatt owns the top of the
 * funnel and every arrival runs on the early-stage deal machine, so the SECOND company emailed in
 * joined the FIRST company's card and vanished. A firm cannot lose an inbound deal to a dedupe rule.
 *
 * Which column is the object depends on where the card came from. A capture-derived card IS about
 * its capture, and its title is whatever the router wrote, so `capture_id` decides. A card opened
 * directly has only its title to name what it is about — "Deal flow: Northwind Robotics" — so the
 * title decides, compared case- and whitespace-insensitively because a retry regenerates it and a
 * stray space is not a second piece of work.
 */
async function duplicateOf(
  env: Env,
  input: CreateWorkCardInput,
  firmScope: string,
): Promise<WorkCardRow | null> {
  // Nothing to match on means nothing to duplicate. A card with no machine and no capture is a
  // one-off somebody typed, and two of those are two different thoughts.
  if (input.machine_id == null && !input.capture_id) return null;
  const row = await env.WP_OS_DB.prepare(
    `SELECT * FROM work_card
      WHERE firm_scope = ?1
        AND state IN ${LIVE_STATES}
        AND IFNULL(owner_id, '') = IFNULL(?2, '')
        AND IFNULL(machine_id, -1) = IFNULL(?3, -1)
        /*
         * THE SAME CAPTURE, OR THE SAME SUBJECT. Either makes it the same piece of work.
         *
         * Capture alone was too narrow and title alone too broad. Two emails about one company —
         * an intro on Monday, an updated deck on Thursday — arrive as two captures, so a
         * capture-only rule opened a second card for a company Wyatt was already working. The title
         * is what actually names the subject ("Deal flow: Sensori"), so it is checked as well, and
         * matching on either is what "one live card per machine, subject and owner" always meant.
         */
        AND (
          (IFNULL(?4, '') <> '' AND capture_id = ?4)
          OR lower(trim(title)) = lower(trim(?5))
        )
      ORDER BY created_at ASC LIMIT 1`,
  )
    .bind(firmScope, input.owner_id ?? null, input.machine_id ?? null, input.capture_id ?? null, input.title)
    .first<WorkCardRow>();
  return row ?? null;
}

/**
 * Whether this owner has stopped working and started looping.
 *
 * Returns the reason when tripped, so the caller can say which limit and by how much rather than
 * "too many". Only counts an OWNER — a partner opening cards by hand is not rate-limited, because a
 * human doing something forty times is a human who means it.
 *
 * COUNTED BY ID, SAID BY NAME. `ownerId` must be the RESOLVED `aie_*` id, because that is what the
 * column holds; `saidAs` is whatever the caller wrote, because "Wyatt has opened 40 work cards" is
 * a sentence a partner can act on and "aie_wyatt has opened 40" is one she has to decode. The two
 * used to be the same argument, and passing the display name made the counts always zero.
 */
async function rateTrip(
  env: Env,
  ownerId: string | null | undefined,
  firmScope: string,
  saidAs?: string | null,
): Promise<string | null> {
  if (!ownerId) return null;
  const who = saidAs?.trim() || ownerId;
  const row = await env.WP_OS_DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM work_card
         WHERE firm_scope = ?1 AND owner_id = ?2
           AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour')) AS last_hour,
       (SELECT COUNT(*) FROM work_card
         WHERE firm_scope = ?1 AND owner_id = ?2 AND state IN ${LIVE_STATES}) AS open_now`,
  )
    .bind(firmScope, ownerId)
    .first<{ last_hour: number; open_now: number }>();
  if (!row) return null;
  if (row.last_hour >= CARDS_PER_HOUR_TRIP) {
    return `${who} has opened ${row.last_hour} work cards in the last hour, past the ${CARDS_PER_HOUR_TRIP} that means something is looping rather than working.`;
  }
  if (row.open_now >= OPEN_CARDS_CEILING) {
    return `${who} is holding ${row.open_now} open work cards, past the ceiling of ${OPEN_CARDS_CEILING}. Nobody works sixty things.`;
  }
  return null;
}

export async function createWorkCardInternal(
  env: Env,
  identity: FirmUserIdentity,
  input: CreateWorkCardInput,
): Promise<WorkCardRow> {
  const firmScope = input.firm_scope ?? "west-peek";
  const actor = actorFromIdentity(identity);
  const authz = await authorize(env, actor, "work_card.create", { objectType: "work_card", firmScope });
  if (authz.decision !== "ALLOW") throw new WorkCardError(403, "forbidden", authz.reason);

  /*
   * A DUPLICATE JOINS THE EXISTING CARD. It does not fail, and it does not open a second one.
   * Returning the original is what keeps the pipeline honest: the second caller gets a real card id
   * and carries on, and the firm has one place where that piece of work lives.
   */
  /*
   * AN AI OWNER IS STORED BY ID, NEVER BY NAME — resolved here so no caller can get it wrong.
   *
   * The bug this closes was live in production and silent. `DEAL_INTAKE_EMPLOYEE` is the string
   * "Wyatt", used for display, and the intake path wrote it straight into `owner_id` while other
   * paths wrote `aie_wyatt`. Two formats in one column. `runEmployeeWork` looks the owner up with
   * `ai_employee WHERE id = ?`, so every card the email intake created answered **"That employee
   * does not exist" and could never be worked** — the whole route from an email to Wyatt doing
   * something died at the last step, and nothing said so. `validate:value-shapes` found it.
   *
   * Resolved rather than rejected: a caller naming a real colleague means something obvious, and
   * refusing would only move the failure. A name that matches nobody still falls through unchanged
   * and fails loudly at the foreign key.
   */
  let ownerId = input.owner_id ?? null;
  if (input.owner_type === "AI" && ownerId && !ownerId.startsWith("aie_")) {
    const seat = await env.WP_OS_DB.prepare("SELECT id FROM ai_employee WHERE name = ?1")
      .bind(ownerId)
      .first<{ id: string }>();
    if (seat) ownerId = seat.id;
  }

  /*
   * RESOLVED BEFORE THE DUPLICATE CHECK, and the order is the bug. Doing it after meant the check
   * compared the raw "Wyatt" against a stored "aie_wyatt" and never matched, so the guard silently
   * stopped guarding for exactly the route it was written for.
   */
  const existing = await duplicateOf(env, { ...input, owner_id: ownerId ?? undefined }, firmScope);
  if (existing) {
    await appendEvent(env, {
      eventType: "work_card.duplicate_joined",
      actorType: "firm_user",
      actorId: identity.id,
      objectType: "work_card",
      objectId: existing.id,
      payload: { title: input.title, machine_id: input.machine_id ?? null, capture_id: input.capture_id ?? null },
    });
    return existing;
  }

  /*
   * A LOOPING EMPLOYEE IS STOPPED HERE AND THE PARTNERS ARE TOLD — the card is refused, but the
   * refusal is the alarm rather than the point. Escalation goes through the health spine, which
   * already reports only what persists, tells both partners once, and announces recovery.
   *
   * THE RESOLVED ID, FOR THE SAME REASON THE DUPLICATE CHECK ABOVE TAKES IT. This read `input.owner_id`
   * — the raw value a caller passed — while `rateTrip` counts `work_card WHERE owner_id = ?` and the
   * column holds `aie_wyatt`. Every machine route into this function names an employee by their
   * display string (`DEAL_INTAKE_EMPLOYEE` "Wyatt", `ROUTING_EMPLOYEE` "Porter",
   * `PORTFOLIO_UPDATE_EMPLOYEE` "Winter", `IC_FACILITATOR` "Poppy"), so both counts came back 0 and
   * the breaker could never trip — for exactly the unattended routes it exists to stop. A partner
   * opening cards by hand was never the risk; a job in a loop is.
   *
   * The event's `objectId` takes it too: it is declared `objectType: "ai_employee"`, so a display
   * name there is the same two-formats-in-one-column fault in the spine rather than in the table.
   */
  const tripped = await rateTrip(env, ownerId, firmScope, input.owner_id);
  if (tripped) {
    await appendEvent(env, {
      eventType: "work_card.rate_limited",
      actorType: "firm_user",
      actorId: identity.id,
      objectType: "ai_employee",
      objectId: ownerId ?? "unknown",
      payload: { detail: tripped },
    });
    throw new WorkCardError(429, "opening_too_fast", tripped);
  }

  const id = `wc_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    `INSERT INTO work_card
       (id, capture_id, title, description, domain_id, machine_id, owner_type, owner_id,
        state, priority, privacy_label, firm_scope, next_action, due_at, created_by, prompt,
        model_access, audience)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'OPEN', ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)`,
  )
    .bind(
      id,
      input.capture_id ?? null,
      input.title,
      input.description ?? null,
      input.domain_id ?? null,
      input.machine_id ?? null,
      input.owner_type ?? "UNASSIGNED",
      // The RESOLVED id, not the raw input — see the note above.
      ownerId,
      input.priority ?? "NORMAL",
      input.privacy_label ?? DEFAULT_PRIVACY_LABEL,
      firmScope,
      input.next_action ?? null,
      input.due_at ?? null,
      identity.id,
      input.prompt ?? null,
      input.model_access ?? "PUBLIC_MODEL_APPROVED",
      input.audience ?? "INTERNAL",
    )
    .run();

  await appendEvent(env, {
    eventType: "work_card.created",
    actorType: "firm_user",
    actorId: identity.id,
    objectType: "work_card",
    objectId: id,
    firmScope,
    payload: { title: input.title, capture_id: input.capture_id ?? null, machine_id: input.machine_id ?? null },
  });

  return (await env.WP_OS_DB.prepare("SELECT * FROM work_card WHERE id = ?1").bind(id).first<WorkCardRow>())!;
}

export async function handleCreateWorkCard(ctx: RouteContext): Promise<Response> {
  const { env, identity } = ctx;
  const body = await parseJsonBody(ctx.request);
  const parsed = createWorkCardSchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  const input = parsed.data;

  try {
    let derived: CreateWorkCardInput = { ...input };
    if (input.capture_id) {
      const capture = await getVisibleCapture(env, identity!, input.capture_id);
      if (!capture) return json({ error: "not_found", detail: "capture not found or not visible" }, { status: 404 });
      // The work card inherits the capture's sensitivity and firm scope.
      derived = {
        ...derived,
        privacy_label: input.privacy_label ?? capture.privacy_label,
        firm_scope: capture.firm_scope,
      };
    }
    const card = await createWorkCardInternal(env, identity!, derived);
    return json(card, { status: 201 });
  } catch (err) {
    if (err instanceof WorkCardError) return json({ error: err.code, detail: err.message }, { status: err.status });
    throw err;
  }
}

export async function handleListWorkCards(ctx: RouteContext): Promise<Response> {
  const url = new URL(ctx.request.url);
  const state = url.searchParams.get("state");
  const ownerId = url.searchParams.get("owner_id");
  const visibility = privacyVisibilityClause(ctx.identity!);
  const scopes = firmScopesOf(ctx.identity!);
  const scopeClause = `firm_scope IN (${scopes.map((s) => `'${s.replaceAll("'", "''")}'`).join(", ")})`;

  const conditions = [scopeClause, visibility];
  const binds: string[] = [];
  if (state) {
    binds.push(state);
    conditions.push(`state = ?${binds.length}`);
  }
  if (ownerId) {
    binds.push(ownerId);
    conditions.push(`owner_id = ?${binds.length}`);
  }
  const rows = await ctx.env.WP_OS_DB.prepare(
    `SELECT * FROM work_card WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC, id`,
  )
    .bind(...binds)
    .all<WorkCardRow>();
  return json({ work_cards: rows.results ?? [] });
}

export async function handleGetWorkCard(ctx: RouteContext): Promise<Response> {
  const card = await getVisibleWorkCard(ctx.env, ctx.identity!, ctx.params.id!);
  if (!card) return json({ error: "not_found" }, { status: 404 });
  return json(card);
}

export async function handleUpdateWorkCard(ctx: RouteContext): Promise<Response> {
  const { env, identity } = ctx;
  const card = await getVisibleWorkCard(env, identity!, ctx.params.id!);
  if (!card) return json({ error: "not_found" }, { status: 404 });

  const body = await parseJsonBody(ctx.request);
  const parsed = updateWorkCardSchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  const input = parsed.data;

  const actor = actorFromIdentity(identity!);
  const authz = await authorize(env, actor, "work_card.update", { objectType: "work_card", objectId: card.id, firmScope: card.firm_scope });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", reason: authz.reason }, { status: 403 });

  /*
   * A PERSON DOES NOT BLOCK A CARD FROM HERE (0173). A block has to say what stopped the work,
   * what would clear it and who can clear it — the columns are NOT NULL at the row for that
   * reason — and this handler carries none of them, so the write would be refused by the trigger
   * with a message nobody could act on. Nothing in the UI offers it; what a person does with work
   * they have decided against is Drop, which is its own state and its own record.
   */
  if (input.state === "BLOCKED" && card.state !== "BLOCKED") {
    return json(
      { error: "cannot_block_by_hand", detail: "Only an employee blocks work, and only with a reason and a way to clear it. If you have decided against this, drop it." },
      { status: 409 },
    );
  }

  if (input.state !== undefined && input.state !== card.state) {
    if (!canTransition(card.state as WorkCardState, input.state)) {
      return json(
        { error: "illegal_transition", detail: `work card cannot transition ${card.state} → ${input.state}` },
        { status: 409 },
      );
    }
  }

  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const field of ["title", "description", "owner_type", "owner_id", "priority", "next_action", "due_at", "state"] as const) {
    if (input[field] !== undefined) {
      binds.push(input[field]);
      sets.push(`${field} = ?${binds.length + 1}`);
    }
  }
  if (sets.length === 0) return json({ error: "invalid_input", detail: "no updatable fields provided" }, { status: 400 });

  await env.WP_OS_DB.prepare(
    `UPDATE work_card SET ${sets.join(", ")}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1`,
  )
    .bind(card.id, ...binds)
    .run();

  const stateChanged = input.state !== undefined && input.state !== card.state;
  await appendEvent(env, {
    eventType: stateChanged ? "work_card.state_changed" : "work_card.updated",
    actorType: "firm_user",
    actorId: identity!.id,
    objectType: "work_card",
    objectId: card.id,
    firmScope: card.firm_scope,
    payload: stateChanged
      ? { from_state: card.state, to_state: input.state }
      : { fields: Object.keys(input) },
  });

  const updated = await env.WP_OS_DB.prepare("SELECT * FROM work_card WHERE id = ?1").bind(card.id).first<WorkCardRow>();
  return json(updated);
}

/**
 * Who is carrying what — the firm's work, grouped by the person or employee doing it.
 *
 * WHY GROUPED BY OWNER. A flat list answers "what is open"; the question actually being asked is
 * "what is my team doing", and that is a question about people. Grouping also exposes the two
 * failures a flat list hides: an owner carrying nothing, and work carrying no owner at all.
 *
 * IT INCLUDES LIVE ACTIVITY, not just cards. An employee running a sweep right now is doing work
 * that no card describes, and a page claiming to show what the team is doing while missing that is
 * lying by omission. Runs and cards are kept SEPARATE in the response rather than merged into one
 * list, because they are different things: a card is work somebody owns over time, a run is a
 * single act that already happened. Turning every run into a card would make cards a log, and a log
 * is the one thing this surface must not become.
 *
 * UNASSIGNED WORK IS ITS OWN GROUP and deliberately first. A card nobody owns is the most likely
 * thing in this system to be quietly dropped.
 */
export async function handleWorkByOwner(ctx: RouteContext): Promise<Response> {
  const visibility = privacyVisibilityClause(ctx.identity!, "wc.privacy_label");

  const cards = await ctx.env.WP_OS_DB.prepare(
    `SELECT wc.id, wc.title, wc.description, wc.state, wc.priority, wc.owner_type, wc.owner_id,
            wc.next_action, wc.due_at, wc.capture_id, wc.created_at, wc.allows_browser,
            -- THE TWO LABELS, SERVED SO THEY ARE VISIBLE ON THE CARD. A label you set once and
            -- never see again cannot be corrected, and a wrong one is exactly what sends a room
            -- packet to the dearest model on the account.
            wc.model_access, wc.audience,
            COALESCE(wc.work_attempts, 0) AS work_attempts,
            -- 0173: a block carries its own sentences and its own doors, so the page never has to
            -- guess what a partner can do about it.
            wc.block_reason, wc.block_trying, wc.block_stopped, wc.block_needed, wc.block_who,
            wc.block_actions_json, wc.blocked_at, wc.block_answered_at,
            -- 0185: which lane refused, and its verbatim words. The doors act on the first; the
            -- second is what "show me what it actually said" opens.
            wc.block_lane, wc.block_lane_name, wc.block_raw,
            -- A CARD THAT IS STILL RETRYING. Written on every failed attempt, so the page can tell
            -- a card that is stumbling from a card that is merely queued — which it could not do on
            -- 17 Sep, when three failures in fourteen minutes all read "Open · queued".
            wc.work_last_failure, wc.work_last_failure_at,
            COALESCE(e.name, u.full_name) AS owner_name,
            e.role AS owner_role
       FROM work_card wc
       LEFT JOIN ai_employee e ON e.id = wc.owner_id AND wc.owner_type = 'AI'
       LEFT JOIN firm_user u  ON u.id = wc.owner_id AND wc.owner_type = 'HUMAN'
      WHERE ${visibility}
        -- LIVE WORK ONLY, AND THAT IS THE FIX RATHER THAN A TRIM.
        --
        -- This query used to return every card the firm had ever made under a LIMIT of 500, and the
        -- page then rendered the first fifty of them. Measured on 18 Sep 2026 against a
        -- day-200 database: 531 finished cards, 50 reachable, 481 gone with nothing on screen
        -- saying so. Worse, the cap is ordered by age — so on the day the firm passes 500 finished
        -- cards, an OPEN card nobody has picked up since March falls off the BOARD, which is the
        -- one row this page exists to keep visible.
        --
        -- Finished work is now served by /api/work-cards/record, which searches, groups and pages
        -- it properly. What is left here is bounded by the firm's actual capacity to have work in
        -- flight, so it needs no cap and can no longer push a waiting card out of its own list.
        AND wc.state IN ('OPEN', 'IN_PROGRESS', 'BLOCKED')
      ORDER BY wc.created_at DESC`,
  ).all<Record<string, unknown>>();

  // What each employee has actually been doing. Recent rather than all time — "currently" is the
  // question, and a run from March answers a different one.
  const runs = await ctx.env.WP_OS_DB.prepare(
    `SELECT r.ai_employee_id, e.name AS employee_name, r.purpose, r.status, r.created_at
       FROM ai_run r
       JOIN ai_employee e ON e.id = r.ai_employee_id
      WHERE r.ai_employee_id IS NOT NULL
      ORDER BY r.created_at DESC
      LIMIT 40`,
  ).all<Record<string, unknown>>();

  // WHAT ANY LOOKS FOUND. A card can send somebody to read a page; without this the answer was
  // stored and invisible, which is worse than not having asked — the work looks undone and the
  // reading gets repeated.
  const looks = await ctx.env.WP_OS_DB.prepare(
    `SELECT id, work_card_id, objective, start_url, status, result_text, refusal_reason, created_at
       FROM browser_task
      WHERE work_card_id IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 100`,
  ).all<Record<string, unknown>>();

  const looksByCard = new Map<string, Record<string, unknown>[]>();
  for (const l of looks.results ?? []) {
    const key = String(l.work_card_id);
    if (!looksByCard.has(key)) looksByCard.set(key, []);
    looksByCard.get(key)!.push(l);
  }

  /*
   * ── THE TRAIL: WHAT THE CLASSIFICATION ACTUALLY CAUSED ────────────────────────────────────────
   *
   * "they should include sensitivity public or private and audience: internal or external ON THE
   * CARD so we can have a trail of how it's working" — the owner, 17 Sep 2026.
   *
   * A label on its own answers "how was this classified". The question worth answering is "DID IT
   * GO WHERE I EXPECTED", and that needs the label and the lane side by side — otherwise she is
   * correlating the Work page against the cost centre by hand, which is how nobody checks.
   *
   * READ FROM `ai_run`, WHICH IS IMMUTABLE. That is what makes this a trail rather than a caption:
   * recategorising a card tomorrow changes where its NEXT run goes and cannot touch the record of
   * where the last one went. A label that could rewrite history would be worse than no label.
   */
  const laneByCard = await ctx.env.WP_OS_DB.prepare(
    `SELECT a.work_card_id, p.provider_key, r.model, r.status, r.actual_usage_json, r.created_at
       FROM ai_run_attribution a
       JOIN ai_run r ON r.id = a.ai_run_id
       LEFT JOIN provider_registry p ON p.id = r.provider_id
      WHERE a.work_card_id IS NOT NULL
        AND r.created_at = (
          SELECT MAX(r2.created_at) FROM ai_run r2
            JOIN ai_run_attribution a2 ON a2.ai_run_id = r2.id
           WHERE a2.work_card_id = a.work_card_id
        )`,
  ).all<{ work_card_id: string; provider_key: string | null; model: string | null; status: string; actual_usage_json: string | null; created_at: string }>();

  const lastRunByCard = new Map<string, { provider_key: string | null; model: string | null; status: string; cost_usd: number | null; at: string }>();
  for (const r of laneByCard.results ?? []) {
    let cost: number | null = null;
    try {
      cost = r.actual_usage_json ? ((JSON.parse(r.actual_usage_json) as { cost_usd?: number }).cost_usd ?? null) : null;
    } catch {
      cost = null;
    }
    lastRunByCard.set(r.work_card_id, { provider_key: r.provider_key, model: r.model, status: r.status, cost_usd: cost, at: r.created_at });
  }

  const employed = await ctx.env.WP_OS_DB.prepare(
    "SELECT id, name, role FROM ai_employee WHERE status = 'ACTIVE' ORDER BY name",
  ).all<{ id: string; name: string; role: string }>();

  const partners = await ctx.env.WP_OS_DB.prepare(
    "SELECT id, full_name FROM firm_user WHERE status = 'ACTIVE' ORDER BY full_name",
  ).all<{ id: string; full_name: string }>();

  return json({
    cards: (cards.results ?? []).map((c) => ({
      ...c,
      looks: looksByCard.get(String(c.id)) ?? [],
      /** Where the card's most recent run actually went. Immutable; a relabel cannot rewrite it. */
      last_run: lastRunByCard.get(String(c.id)) ?? null,
      block: blockOf(c as never),
    })),
    recent_runs: runs.results ?? [],
    /** Everyone a card can be given to, so the UI never offers an owner the server would refuse. */
    assignable: {
      employees: employed.results ?? [],
      partners: partners.results ?? [],
    },
    note:
      "Cards are work somebody owns over time. Runs are single acts that already happened. They are " +
      "kept apart on purpose — turning every run into a card would make this a log.",
  });
}

/**
 * THE RECORD — every finished card, searchable, grouped by month, identical runs collapsed.
 *
 * WHY THIS IS A ROUTE AND NOT A FILTER ON THE BOARD. `by-owner` capped at 500 rows and the page
 * sliced 50 of them; at day-200 volume that made 481 of 531 finished cards unreachable with no
 * symptom on screen. Filtering a truncated list client-side would have kept the truncation and
 * hidden it behind a search box that appeared to work — the worse of the two states, because she
 * would then TRUST an empty result. Retrieval belongs where the rows are.
 *
 * THE COLLAPSE IS IN SQL, NOT IN THE CLIENT, for the same reason. Collapsing after paging gives a
 * page of eleven rows where the reader asked for forty; collapsing before paging is only possible
 * where the whole set is. `RECORD_GROUP_COLUMNS` in `@shared/work/record` is the definition of
 * "the same thing, run again", and `validate:record-scales` reads that array and requires the
 * GROUP BY below to name exactly those columns, so the two cannot drift apart.
 *
 * SEARCH COVERS THE RESULT LINE, NOT JUST THE TITLE. What she remembers about last month's Room
 * packet is "Black lawyers" — which is in the line an employee wrote, not in the title the
 * machinery generated.
 */
const recordQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  who: z.string().trim().max(120).optional(),
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  state: z.enum(RECORD_STATES).optional(),
  cursor: z.coerce.number().int().min(0).max(100_000).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export async function handleWorkRecord(ctx: RouteContext): Promise<Response> {
  const visibility = privacyVisibilityClause(ctx.identity!, "wc.privacy_label");
  const url = new URL(ctx.request.url);
  const parsed = recordQuerySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    return json({ error: "invalid_input", detail: parsed.error.issues[0]?.message ?? "bad query" }, { status: 400 });
  }
  const { q, who, month, cursor = 0 } = parsed.data;
  const state: RecordState = parsed.data.state ?? "ALL";
  const limit = parsed.data.limit ?? 40;

  /*
   * FINISHED MEANS DONE OR DROPPED, AND A DROPPED CARD IS PART OF THE RECORD. A decision not to do
   * something is still a decision; hiding it would make this a highlight reel. It is filterable and
   * labelled differently, and it is never silently absent.
   */
  const where: string[] = [visibility, "wc.state IN ('DONE', 'CANCELLED')"];
  const binds: unknown[] = [];
  const bind = (value: unknown): string => {
    binds.push(value);
    return `?${binds.length}`;
  };
  if (state !== "ALL") where.push(`wc.state = ${bind(state)}`);
  if (who) where.push(`wc.owner_id = ${bind(who)}`);
  if (month) where.push(`substr(wc.created_at, 1, 7) = ${bind(month)}`);
  if (q) {
    // Bound, never interpolated. A search box is user input and this one runs against the firm's
    // entire history; the wildcards in what she typed are escaped so a stray % is a percent sign.
    const like = `%${q.replace(/[%_\\]/g, (ch) => `\\${ch}`)}%`;
    where.push(
      `(wc.title LIKE ${bind(like)} ESCAPE '\\' OR COALESCE(wc.description, '') LIKE ${bind(like)} ESCAPE '\\')`,
    );
  }
  const filter = where.join("\n        AND ");
  const groupBy = RECORD_GROUP_COLUMNS.map((c) => RECORD_GROUP_SQL[c]).join(", ");
  /** The same key as one string, for counting distinct groups without a subquery. */
  const groupKey = RECORD_GROUP_COLUMNS.map((c) => `COALESCE(${RECORD_GROUP_SQL[c]}, '')`).join(" || ' ' || ");

  const page = await ctx.env.WP_OS_DB.prepare(
    `SELECT wc.title    AS title,
            wc.state    AS state,
            wc.owner_id AS owner_id,
            COALESCE(e.name, u.full_name) AS owner_name,
            substr(wc.created_at, 1, 7)   AS month,
            MAX(wc.created_at)            AS at,
            COUNT(*)                      AS runs,
            wc.id           AS id,
            wc.description  AS description,
            wc.model_access AS model_access,
            wc.audience     AS audience,
            wc.kind         AS kind
       FROM work_card wc
       LEFT JOIN ai_employee e ON e.id = wc.owner_id AND wc.owner_type = 'AI'
       LEFT JOIN firm_user u  ON u.id = wc.owner_id AND wc.owner_type = 'HUMAN'
      WHERE ${filter}
      GROUP BY ${groupBy}
      ORDER BY at DESC
      LIMIT ${limit + 1} OFFSET ${cursor}`,
  )
    .bind(...binds)
    .all<Record<string, unknown>>();

  /*
   * `wc.id` AND `wc.description` ARE THE ROW THAT PRODUCED `MAX(created_at)`, and that is a
   * documented SQLite guarantee rather than luck: in a query with exactly one bare MAX() or MIN()
   * aggregate, every bare column is taken from the row that produced it. So "Reopen" acts on the
   * most recent attempt and the result line is that attempt's, not an arbitrary sibling's. If this
   * query ever grows a second bare aggregate the guarantee lapses, which `validate:record-scales`
   * checks for.
   */
  const raw = page.results ?? [];
  const hasMore = raw.length > limit;
  const rows = raw.slice(0, limit);

  const counts = await ctx.env.WP_OS_DB.prepare(
    `SELECT COUNT(*) AS cards, COUNT(DISTINCT ${groupKey}) AS row_count
       FROM work_card wc
      WHERE ${filter}`,
  )
    .bind(...binds)
    .first<{ cards: number; row_count: number }>();

  const totals = await ctx.env.WP_OS_DB.prepare(
    `SELECT COUNT(*) AS cards, COUNT(DISTINCT ${groupKey}) AS row_count, MIN(wc.created_at) AS since
       FROM work_card wc
      WHERE ${visibility} AND wc.state IN ('DONE', 'CANCELLED')`,
  ).first<{ cards: number; row_count: number; since: string | null }>();

  /*
   * THE FACETS COUNT THE WHOLE RECORD, NOT THE CURRENT FILTER. A month list that shrank as she
   * typed would remove the very control she needs to widen the search again.
   */
  const months = await ctx.env.WP_OS_DB.prepare(
    `SELECT substr(wc.created_at, 1, 7) AS month, COUNT(*) AS cards
       FROM work_card wc
      WHERE ${visibility} AND wc.state IN ('DONE', 'CANCELLED')
      GROUP BY month ORDER BY month DESC LIMIT 60`,
  ).all<{ month: string; cards: number }>();

  const people = await ctx.env.WP_OS_DB.prepare(
    `SELECT wc.owner_id AS owner_id, COALESCE(e.name, u.full_name, 'Nobody') AS name, COUNT(*) AS cards
       FROM work_card wc
       LEFT JOIN ai_employee e ON e.id = wc.owner_id AND wc.owner_type = 'AI'
       LEFT JOIN firm_user u  ON u.id = wc.owner_id AND wc.owner_type = 'HUMAN'
      WHERE ${visibility} AND wc.state IN ('DONE', 'CANCELLED') AND wc.owner_id IS NOT NULL
      GROUP BY wc.owner_id, name ORDER BY cards DESC LIMIT 40`,
  ).all<{ owner_id: string; name: string; cards: number }>();

  return json({
    rows: rows.map((r) => {
      // The verdict is the LAST "• …" line the employee wrote. Everything above it is working.
      const lines = String(r.description ?? "").split("\n").filter((l) => l.startsWith("• "));
      return {
        id: String(r.id),
        title: String(r.title),
        state: String(r.state),
        owner_id: (r.owner_id as string | null) ?? null,
        owner_name: (r.owner_name as string | null) ?? null,
        month: String(r.month),
        at: String(r.at),
        runs: Number(r.runs ?? 1),
        result: lines.length > 0 ? lines[lines.length - 1]!.slice(2, 402) : null,
        model_access: String(r.model_access ?? "PUBLIC_MODEL_APPROVED"),
        audience: String(r.audience ?? "INTERNAL"),
        kind: (r.kind as string | null) ?? null,
      };
    }),
    matched: { cards: counts?.cards ?? 0, rows: counts?.row_count ?? 0 },
    total: { cards: totals?.cards ?? 0, rows: totals?.row_count ?? 0 },
    next_cursor: hasMore ? String(cursor + limit) : null,
    months: (months.results ?? []).map((m) => ({ ...m, label: monthLabel(m.month) })),
    people: people.results ?? [],
    since: totals?.since ?? null,
  });
}

/**
 * A partner telling an employee something while the work is being done.
 *
 * Operator, 22 Aug 2026: "can the MPs give feedback on a work card that we want the ai employee to
 * acknowledge while they are doing the work?"
 *
 * NOT AN APPROVAL, and deliberately not routed through one. Approving is a decision at a moment;
 * this is steering something already in motion, and it must not stop the work to wait for a round
 * trip. The note lands in the employee's prompt on their next step — see `employeeLoop.ts`, where it
 * is placed ABOVE the original brief because it was said later and while watching the work.
 */
export async function handleAddWorkCardNote(ctx: RouteContext): Promise<Response> {
  const body = (await ctx.request.json().catch(() => null)) as { body?: unknown } | null;
  const text = typeof body?.body === "string" ? body.body.trim() : "";
  if (text.length < 2) return json({ error: "invalid_input", detail: "Say what you want them to do differently." }, { status: 400 });

  const card = await ctx.env.WP_OS_DB.prepare("SELECT id, state FROM work_card WHERE id = ?1")
    .bind(ctx.params.id!)
    .first<{ id: string; state: string }>();
  if (!card) return json({ error: "not_found" }, { status: 404 });

  // A note on finished work would never be read: the loop only re-reads notes on a card it is
  // still working. Refusing plainly beats accepting it into a void.
  if (!["OPEN", "IN_PROGRESS", "BLOCKED"].includes(card.state)) {
    return json(
      { error: "not_in_flight", detail: "This work is finished, so nobody will read a note on it. Reopen the card first." },
      { status: 409 },
    );
  }

  const id = `wcn_${crypto.randomUUID()}`;
  await ctx.env.WP_OS_DB.prepare(
    "INSERT INTO work_card_note (id, work_card_id, author_id, body) VALUES (?1, ?2, ?3, ?4)",
  )
    .bind(id, card.id, ctx.identity!.id, text)
    .run();

  await appendEvent(ctx.env, {
    eventType: "work_card.note_left",
    actorType: "firm_user",
    actorId: ctx.identity!.id,
    objectType: "work_card",
    objectId: card.id,
    payload: { note_id: id },
  });

  return json({ id, waiting: true }, { status: 201 });
}

/** What has been said on this card, and what came back. */
export async function handleListWorkCardNotes(ctx: RouteContext): Promise<Response> {
  const rows = await ctx.env.WP_OS_DB.prepare(
    `SELECT n.id, n.body, n.response, n.acknowledged_at, n.created_at, fu.full_name AS author
       FROM work_card_note n
       LEFT JOIN firm_user fu ON fu.id = n.author_id
      WHERE n.work_card_id = ?1
      ORDER BY n.created_at ASC`,
  )
    .bind(ctx.params.id!)
    .all<Record<string, unknown>>();
  return json({ notes: rows.results ?? [] });
}
