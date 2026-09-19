import { z } from "zod";
import type { Env } from "../env";
import type { RouteContext } from "../router";
import { json } from "../router";
import { appendEvent } from "../events";
import { actorFromIdentity, authorize, type Actor } from "./authorize";
import {
  InvestmentError,
  confirmPlaceholders,
  createSecurityClass,
  createTransaction,
  getOpportunity,
  submitTransactionForApproval,
  type OpportunityRow,
  type TransactionRow,
} from "./investment";
import { manualArrival, openIntoFunnel } from "./dealIntake";

/**
 * Booking a holding from the Portfolio row — Phase D: portfolio (design §6 and §12.4, owner-approved
 * 18 Sep 2026).
 *
 * THE OWNER'S WORDS: "there needs to be an easy intuitive way to book a company as a real Fund I
 * position and the MPs should be able to add the data there and save." Until now booking meant
 * three screens: a share class on the deal record, a draft, a submission, a decision on Approvals,
 * then back to the record to paste the card's id. The firm's one investment — Sensori, a pre-fund
 * SPV recorded with a $1 × 10,000 stand-in — never walked it.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT. It is ONE SAVE for the partner, and it is not a new door into the
 * ledger. `bookHolding` walks the EXISTING path in the existing order — share class →
 * `createTransaction` (a DRAFT, arithmetic that commits nothing) → `submitTransactionForApproval`
 * (the `investment.approve` card, MP-reserved) — and stops there. The position is opened when a
 * partner approves the card (`bookOnApproval` → `executeTransaction`), which is the only place a
 * position is ever opened. Nothing in this file writes `position`; `validate:booking` reads the
 * code to keep that true, and its negative proof breaks it on purpose.
 *
 * MONEY-SHAPED WRITES, so the rules the security review asks for are stated here:
 *   · `authorize()` on every step, inside the functions this composes — `security_class.create`,
 *     `transaction.create`, `approval.request`, `opportunity.confirm_placeholder` — none is skipped
 *     by being composed;
 *   · no client-trusted amounts: the caller sends price, count, date, class, vehicle and fund; gross
 *     and net are computed by `createTransaction`, the card's title and summary are written from the
 *     row, and the fund must exist;
 *   · the stand-ins heal from the SAME figures: Sensori's `placeholder_fields` are confirmed with the
 *     price and count the partner typed — never the other way round, the form never pre-fills from
 *     the placeholder (design §6: "the form must let the MPs enter the REAL terms");
 *   · one booking in flight per company: a DRAFT or PENDING transaction on the company refuses a
 *     second, so a partner who presses Save twice raises one card, not two.
 */

const bookSchema = z.object({
  /** The closed deal this books. Optional: a company can be booked from a position-less closed row. */
  opportunity_id: z.string().trim().min(1).optional(),
  /** An existing class, or a new one by name — exactly one of the two. */
  security_class_id: z.string().trim().min(1).optional(),
  class_name: z.string().trim().min(2).max(80).optional(),
  price_per_share: z.number().positive().finite(),
  quantity: z.number().positive().finite(),
  fees: z.number().min(0).finite().optional(),
  transaction_date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "a date, as YYYY-MM-DD"),
  vehicle: z.string().trim().min(1).max(80),
  fund_id: z.string().trim().min(1),
  /** False keeps the draft unsent (the row reads "draft"); the default is one Save that raises the card. */
  send: z.boolean().optional(),
});

export type BookHoldingInput = z.infer<typeof bookSchema>;

export interface BookHoldingResult {
  transaction: TransactionRow;
  approval_card_id: string | null;
  security_class_id: string;
  /** Which of the deal's placeholder fields this save replaced with the partner's real figures. */
  healed: string[];
}

/** The transaction type the ledger wants for a booking of this kind of deal. */
function transactionTypeFor(opportunity: OpportunityRow | null): TransactionRow["transaction_type"] {
  switch (opportunity?.opportunity_type) {
    case "SECONDARY_PURCHASE":
      return "PURCHASE";
    case "FOLLOW_ON":
      return "FOLLOW_ON";
    default:
      return "PRIMARY_INVESTMENT";
  }
}

/** The booking already in flight on a company, if any: a draft or one waiting on a partner. */
export async function bookingInFlight(env: Env, companyId: string): Promise<TransactionRow | null> {
  return env.WP_OS_DB.prepare(
    `SELECT * FROM "transaction" WHERE company_id = ?1 AND status IN ('DRAFT','PENDING_APPROVAL','APPROVED')
      ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(companyId)
    .first<TransactionRow>();
}

export async function bookHolding(env: Env, actor: Actor, companyId: string, input: BookHoldingInput): Promise<BookHoldingResult> {
  if ((input.security_class_id ? 1 : 0) + (input.class_name ? 1 : 0) !== 1) {
    throw new InvestmentError(400, "class_required", "Pick a share class, or name a new one — one or the other.");
  }
  const company = await env.WP_OS_DB.prepare("SELECT id, canonical_name FROM canonical_company WHERE id = ?1")
    .bind(companyId)
    .first<{ id: string; canonical_name: string }>();
  if (!company) throw new InvestmentError(404, "unknown_company", `canonical_company '${companyId}' does not exist`);

  const opportunity = input.opportunity_id ? await getOpportunity(env, input.opportunity_id) : null;
  if (input.opportunity_id && (!opportunity || opportunity.company_id !== companyId)) {
    throw new InvestmentError(400, "unknown_opportunity", "opportunity does not exist or belongs to another company");
  }

  const inFlight = await bookingInFlight(env, companyId);
  if (inFlight) {
    throw new InvestmentError(
      409,
      "booking_in_flight",
      inFlight.status === "DRAFT"
        ? "A draft booking already exists for this company. Send it, or edit it on the company's record."
        : "This company's booking is already waiting on a partner. Approving that card books it.",
    );
  }

  // 1. The share class — created through its own governed function when named here.
  const securityClassId = input.security_class_id ?? (await createSecurityClass(env, actor, { company_id: companyId, class_name: input.class_name! })).id;

  // 2. The draft. Gross, fees, net are the ledger's arithmetic; the fund must exist.
  const transaction = await createTransaction(env, actor, {
    company_id: companyId,
    ...(opportunity ? { opportunity_id: opportunity.id } : {}),
    transaction_type: transactionTypeFor(opportunity),
    security_class_id: securityClassId,
    quantity: input.quantity,
    price_per_share: input.price_per_share,
    fees: input.fees ?? 0,
    transaction_date: input.transaction_date,
    fund_id: input.fund_id,
    vehicle: input.vehicle,
  });

  // 3. The stand-ins heal from the partner's real figures — only the fields the deal itself marks
  //    provisional, through the door that exists for exactly that (confirmPlaceholders).
  let healed: string[] = [];
  if (opportunity) {
    let outstanding: string[] = [];
    try {
      outstanding = JSON.parse(opportunity.placeholder_fields || "[]") as string[];
    } catch {
      outstanding = [];
    }
    const values: Record<string, number> = {};
    if (outstanding.includes("price_per_share")) values.price_per_share = input.price_per_share;
    if (outstanding.includes("quantity")) values.quantity = input.quantity;
    healed = Object.keys(values);
    if (healed.length > 0) await confirmPlaceholders(env, actor, opportunity.id, values);
  }

  // 4. The card, unless the partner asked to keep a draft.
  let approvalCardId: string | null = null;
  let current = transaction;
  if (input.send !== false) {
    current = await submitTransactionForApproval(env, actor, transaction.id);
    approvalCardId = current.approval_card_id;
  }

  const { actorType, actorId } = actor.type === "HUMAN" ? { actorType: "firm_user" as const, actorId: actor.firmUserId! } : { actorType: "ai_employee" as const, actorId: actor.aiEmployeeId ?? "system" };
  await appendEvent(env, {
    eventType: "portfolio.holding_booking_saved",
    actorType,
    actorId,
    objectType: "transaction",
    objectId: transaction.id,
    firmScope: transaction.firm_scope,
    payload: {
      company_id: companyId,
      opportunity_id: opportunity?.id ?? null,
      fund_id: input.fund_id,
      vehicle: input.vehicle,
      sent: input.send !== false,
      approval_card_id: approvalCardId,
      healed,
    },
  });

  return { transaction: current, approval_card_id: approvalCardId, security_class_id: securityClassId, healed };
}

function errorResponse(err: unknown): Response {
  if (err instanceof InvestmentError) return json({ error: err.code, detail: err.message }, { status: err.status });
  throw err;
}

async function parseJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/** POST /api/holdings/:company_id/book — one Save: class → draft → the partner's card. */
export async function handleBookHolding(ctx: RouteContext): Promise<Response> {
  const parsed = bookSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await bookHolding(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.company_id!, parsed.data), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

// ── A sale starts from the Portfolio row (design §6/§8, decision Q5) ────────────────────────────

/**
 * "Sell" on a booked holding opens a SECONDARY_SALE opportunity for that company on Dealflow, through
 * the ordinary manual door (`openIntoFunnel` → `createOpportunity`, `opportunity.create` authorized
 * under the partner's own name). It sells NOTHING: a sale is a deal like any other and walks the
 * stage rail; the SALE transaction that reduces the position is drafted on that deal's record and
 * executes behind `secondary_sale.approve`. The Secondaries tab (D5) lists these by the fields
 * written here — see the PR body, "for D5".
 */
export interface SaleOpened {
  opportunity_id: string;
  status: string;
  already_open: boolean;
}

export async function sellHolding(env: Env, identity: NonNullable<RouteContext["identity"]>, companyId: string): Promise<SaleOpened> {
  const company = await env.WP_OS_DB.prepare("SELECT id, canonical_name FROM canonical_company WHERE id = ?1")
    .bind(companyId)
    .first<{ id: string; canonical_name: string }>();
  if (!company) throw new InvestmentError(404, "unknown_company", `canonical_company '${companyId}' does not exist`);

  const position = await env.WP_OS_DB.prepare(
    `SELECT id, fund_id, security_class_id, quantity, cost_basis FROM position
      WHERE company_id = ?1 AND status = 'OPEN' ORDER BY opened_at LIMIT 1`,
  )
    .bind(companyId)
    .first<{ id: string; fund_id: string; security_class_id: string; quantity: number; cost_basis: number }>();
  if (!position) {
    throw new InvestmentError(409, "not_booked", "Only a booked holding can be sold. Book it first; the fund cannot sell what its ledger does not hold.");
  }

  const open = await env.WP_OS_DB.prepare(
    `SELECT id, status FROM investment_opportunity
      WHERE company_id = ?1 AND opportunity_type = 'SECONDARY_SALE'
        AND status NOT IN ('CLOSED','PASS','WITHDRAWN') AND archived_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(companyId)
    .first<{ id: string; status: string }>();
  if (open) return { opportunity_id: open.id, status: open.status, already_open: true };

  const entry = await openIntoFunnel(
    env,
    manualArrival(identity, {
      company: company.canonical_name,
      company_id: companyId,
      opportunity_type: "SECONDARY_SALE",
      title: `Sale of the fund's ${company.canonical_name} holding`,
      source_channel: "portfolio:sell",
      security_class_id: position.security_class_id,
      quantity: position.quantity,
      terms: {
        opened_from: "portfolio_row",
        position_id: position.id,
        fund_id: position.fund_id,
        held_quantity: position.quantity,
        cost_basis_usd: position.cost_basis,
      },
    }),
  );
  return { opportunity_id: entry.opportunity.id, status: entry.opportunity.status, already_open: false };
}

/** POST /api/holdings/:company_id/sell — open the sale on Dealflow; the row reads "sale open". */
export async function handleSellHolding(ctx: RouteContext): Promise<Response> {
  try {
    const opened = await sellHolding(ctx.env, ctx.identity!, ctx.params.company_id!);
    return json(opened, { status: opened.already_open ? 200 : 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

// ── A reserve for each company (migration 0210) ─────────────────────────────────────────────────

const reserveSchema = z.object({
  amount: z.number().min(0).finite(),
  as_of_date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "a date, as YYYY-MM-DD"),
  note: z.string().trim().max(600).optional(),
});

/**
 * POST /api/positions/:id/reserve — earmark follow-on capital for one company. An MP write behind
 * `position.reserve` (not a card: intent, not money moving), append-only like a mark. The fund-level
 * reserve on Fund strategy stays the plan the ring draws; this is the per-company answer.
 */
export async function handleReservePosition(ctx: RouteContext): Promise<Response> {
  const parsed = reserveSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });

  const actor = actorFromIdentity(ctx.identity!);
  if (actor.type !== "HUMAN" || !actor.roles.includes("MANAGING_PARTNER")) {
    return json({ error: "forbidden", detail: "Only a Managing Partner may reserve capital for a holding." }, { status: 403 });
  }
  const firmScope = actor.firmScopes[0] ?? "west-peek";
  const authz = await authorize(ctx.env, actor, "position.reserve", { objectType: "position", objectId: ctx.params.id!, firmScope });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });

  const position = await ctx.env.WP_OS_DB.prepare("SELECT id, status FROM position WHERE id = ?1").bind(ctx.params.id!).first<{ id: string; status: string }>();
  if (!position) return json({ error: "not_found" }, { status: 404 });
  if (position.status !== "OPEN") {
    return json({ error: "position_closed", detail: "This holding is closed; there is nothing to reserve for." }, { status: 409 });
  }

  const id = `prs_${crypto.randomUUID()}`;
  const amountMinor = Math.round(parsed.data.amount * 100);
  await ctx.env.WP_OS_DB.prepare(
    `INSERT INTO position_reserve (id, position_id, amount_minor, as_of_date, note, set_by, firm_scope)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  )
    .bind(id, position.id, amountMinor, parsed.data.as_of_date, parsed.data.note ?? null, actor.firmUserId!, firmScope)
    .run();

  await appendEvent(ctx.env, {
    eventType: "position.reserved",
    actorType: "firm_user",
    actorId: actor.firmUserId!,
    objectType: "position",
    objectId: position.id,
    firmScope,
    payload: { amount_minor: amountMinor, as_of: parsed.data.as_of_date, note: parsed.data.note ?? null },
  });

  return json({ id, amount: parsed.data.amount, as_of_date: parsed.data.as_of_date }, { status: 201 });
}
