import type { Env } from "../env";
import type { Actor } from "./authorize";
import { runAi } from "../ai/runAi";
import { blockCard } from "./blocks";
import { cannotDetail, steerFor, type Interpreter } from "./instruction";
import { sendOrPreview } from "./previewApproval";
import { deliver } from "./deliverables";
import { appendEvent } from "../events";
import type { SweepCard } from "./workSweep";
import { partnerFor, type Partner } from "../../shared/registry/partners";
import { personaPrompt } from "../../shared/registry/aiEmployeePersonas";
import { bulletsFrom, type ExecEmailInput } from "../../shared/email/execEmail";

/**
 * PARTNER_MESSAGE — one employee, named, tells one partner, named, something short (22 Sep 2026).
 *
 * ─── WHY THIS DUTY EXISTS ───────────────────────────────────────────────────────────────────────
 *
 * Every existing employee→partner email fired as a side effect of finishing a TYPED card with its
 * own declared step list — a web property change, a hire search, blog help. None of them existed
 * to do the plain thing Sequoia actually needed today: "Walker, tell Scooter Nora's email and that
 * the parsing bug is fixed." This is that card kind, and its ENTIRE job is composing one short
 * message and filing it. See `shared/intake/partnerMessage.ts` for how the ask is read at the
 * email door, and `shared/work/cardKinds.ts` for the registry entry.
 *
 * ─── PURE REUSE, NO NEW SEND MECHANISM ─────────────────────────────────────────────────────────
 *
 * `filePreview()`/`sendOrPreview()` already mint the token, write the `preview_approval` row, land
 * a copy on Home, and email the owning partner the three buttons — the SAME door every other duty
 * in this file's neighbourhood (`productionsHire.ts`, `blogHelp.ts`) already walks through. This
 * runner composes the words and hands them to that door unchanged; it does not touch how a message
 * leaves the firm, and it does not invent a second lane for "internal, so send it straight out" —
 * `sendOrPreview` already asks the partner registry that question via `previewFirstFor`, and
 * `card.preview_first` (the "Show me first?" checkbox, Addendum 8) already overrides it either way.
 *
 * ─── TWO THINGS THAT MUST BE REAL, OR NOTHING SENDS ─────────────────────────────────────────────
 *
 *   1. THE EMPLOYEE. `card.owner_id` must name a real, ACTIVE row in `ai_employee`. An employee who
 *      is OFFBOARDING, PAUSED, or simply does not exist cannot be made to speak by naming them on a
 *      card — the same rule `assignCard` already holds a hand-off to.
 *   2. THE PARTNER. `card.result_recipient` must resolve, through `shared/registry/partners.ts`, to
 *      one of the two Managing Partners — never an arbitrary address. `filePreview()`'s own `owner:
 *      Partner` type already enforces this at the send end; this is the same guarantee enforced at
 *      the intake end, so a card that reaches the send call has already proven it.
 *
 * Either failing is a BLOCKED card with a plain reason, never a silent no-op and never a guess.
 */

export const PARTNER_MESSAGE_KIND = "PARTNER_MESSAGE" as const;

/**
 * What this duty can actually do, named for the interpretation pass (`services/instruction.ts`).
 * Without this list a partner's own words on the card cannot be told apart from a directive this
 * chain has no step for — see `buildInterpretationPrompt`.
 */
export const PARTNER_MESSAGE_STEPS: readonly string[] = [
  "Read the instruction and compose ONE short message, in the employee's own voice, saying exactly what was asked and nothing that was not.",
  "Address it to the one partner named on the card, resolved from the partner registry — never anyone else, and never a second recipient.",
  "File it through the firm's existing preview door (filePreview/sendOrPreview) so it reaches the partner exactly like any other employee email — this duty never invents a second way to send.",
  "A Managing Partner's own instruction extends what you do here — apply it using judgement and whatever you already have access to, rather than treating it as out of scope. Only decline something that genuinely needs a tool, data source or integration that does not exist anywhere in this system, or that would need to pass through approval regardless of who asked.",
];

export type PartnerMessageComposer = (
  env: Env,
  actor: Actor,
  prompt: string,
) => Promise<{ ok: boolean; text: string; detail: string }>;

const defaultCompose: PartnerMessageComposer = async (env, actor, prompt) => {
  const { run } = await runAi(env, {
    purpose: "composing a short message to a partner",
    actor,
    inputs: [prompt],
    sensitivity: "INTERNAL" as never,
    budgetContext: {
      expectedOutputTokens: 500,
      // Drafting something a partner will actually send — the exact case `judgement` exists for.
      judgement: true,
    },
    routing: { category: "OPERATIONS" },
  });
  if (run.status !== "COMPLETED" || !run.output_text) {
    return { ok: false, text: "", detail: run.failure_reason ?? `run ${run.status}` };
  }
  return { ok: true, text: run.output_text, detail: "ok" };
};

function buildComposePrompt(input: {
  employee: string;
  role: string;
  partner: Partner;
  instruction: string;
  steerText: string;
}): string {
  return [
    personaPrompt(input.employee, input.role),
    "",
    `You are writing ONE short message to ${input.partner.fullName}, a Managing Partner of West Peek`,
    "Ventures. They asked to be told something, and this is the whole job: say it plainly, in your",
    "own voice, and nothing more.",
    "",
    ...(input.steerText ? [input.steerText, ""] : []),
    "WHAT YOU HAVE BEEN ASKED TO TELL THEM, in the words you were given:",
    input.instruction,
    "",
    "Write the message now. Plain prose, addressed to them directly, 1 to 4 short sentences. No",
    '"Hi <name>," greeting and no sign-off — those are added by the format automatically. Say only',
    "what you were told; never invent a fact, a name, a date or a number you were not given. Output",
    "nothing but the message itself.",
  ].join("\n");
}

export interface PartnerMessageDeps {
  compose?: PartnerMessageComposer;
  interpret?: Interpreter;
}

export interface PartnerMessageOutcome {
  finished: boolean;
  blocked: boolean;
  detail: string;
}

interface EmployeeRow {
  id: string;
  name: string;
  role: string;
  status: string;
}

/**
 * Work one PARTNER_MESSAGE card to a conclusion: resolve the employee and the partner (fail closed
 * on either), read what she asked for (`steerFor`, the same contract every other chain keeps),
 * compose the message, and file it through `sendOrPreview` — DONE, or BLOCKED with the reason on
 * the card and nothing sent.
 */
export async function runPartnerMessageCard(
  env: Env,
  card: SweepCard,
  deps: PartnerMessageDeps = {},
): Promise<PartnerMessageOutcome> {
  // 1 · THE EMPLOYEE — real and ACTIVE, or this stops here. Fail closed, never a guess.
  const employeeRow = card.owner_id
    ? await env.WP_OS_DB.prepare("SELECT id, name, role, status FROM ai_employee WHERE id = ?1")
        .bind(card.owner_id)
        .first<EmployeeRow>()
    : null;
  if (!employeeRow || employeeRow.status !== "ACTIVE") {
    const employeeLabel = employeeRow?.name ?? card.owner_id ?? "nobody";
    const blocked = await blockCard(env, card, {
      reason: "asked_for_something_this_work_cannot_do",
      trying: card.title,
      employee: employeeLabel,
      detail: employeeRow
        ? `${employeeRow.name} is ${employeeRow.status.toLowerCase()}, not employed right now — switch them on from Employees, or hand this to somebody else.`
        : `Nobody real is set to carry this — "${employeeLabel}" is not on the roster. Assign it to a real, active employee.`,
    });
    return { finished: false, blocked: true, detail: blocked };
  }

  // 2 · THE PARTNER — resolved from the registry, never an arbitrary address. Fail closed.
  const partner = partnerFor(card.result_recipient ?? null);
  if (!partner) {
    const blocked = await blockCard(env, card, {
      reason: "asked_for_something_this_work_cannot_do",
      trying: card.title,
      employee: employeeRow.name,
      detail: `"${(card.result_recipient ?? "").trim() || "nobody"}" is not one of the two Managing Partners, so there is nobody real to send this to. Set "Who is this for?" to Scooter or Sequoia.`,
    });
    return { finished: false, blocked: true, detail: blocked };
  }

  // 3 · WHAT TO SAY. `card.prompt` ("How to do it") carries the instruction on every door this
  // kind is reachable from — the Create door's own field, and the email door's parsed instruction
  // (`services/dealIntake.ts`). `next_action` is the fallback for a hand-edited card that moved it.
  const instruction = (card.prompt ?? "").trim() || (card.next_action ?? "").trim();
  if (!instruction) {
    const blocked = await blockCard(env, card, {
      reason: "the_brief_is_missing",
      trying: card.title,
      employee: employeeRow.name,
      detail: `There is nothing to say — say in your own words what ${employeeRow.name} should tell ${partner.firstName}.`,
    });
    return { finished: false, blocked: true, detail: blocked };
  }

  const actor: Actor = { type: "AI", aiEmployeeId: employeeRow.id, roles: [], firmScopes: [card.firm_scope] };

  /*
   * HER WORDS, READ THE SAME WAY EVERY OTHER CHAIN NOW READS THEM (`services/instruction.ts`). The
   * instruction itself already reaches this runner through `card.prompt` above; `steerFor` is what
   * lets a NOTE left after the card was created — "actually also mention the deadline" — land on
   * this run, and what turns something genuinely out of scope into a clean CANNOT rather than a
   * card that quietly sends the wrong thing.
   */
  const steer = await steerFor(
    env,
    actor,
    {
      cardId: card.id,
      cardKind: PARTNER_MESSAGE_KIND,
      title: card.title,
      employee: employeeRow.name,
      chain: `a short message to ${partner.firstName}`,
      steps: [...PARTNER_MESSAGE_STEPS],
      firmScope: card.firm_scope,
    },
    deps.interpret,
  );
  if (steer.cannot.length > 0) {
    const blocked = await blockCard(env, card, {
      reason: steer.failure ? "the_brief_is_missing" : "asked_for_something_this_work_cannot_do",
      trying: card.title,
      employee: employeeRow.name,
      detail: steer.failure ? undefined : cannotDetail(employeeRow.name, steer.cannot),
    });
    return { finished: false, blocked: true, detail: blocked };
  }

  // 4 · COMPOSE — through the employee's own AI capability, the same `runAi` every duty calls.
  const compose = deps.compose ?? defaultCompose;
  const prompt = buildComposePrompt({
    employee: employeeRow.name,
    role: employeeRow.role,
    partner,
    instruction,
    steerText: steer.text,
  });
  const written = await compose(env, actor, prompt);
  const message = written.ok ? written.text.trim() : "";
  if (!message) {
    const blocked = await blockCard(env, card, {
      reason: "tried_and_could_not_finish",
      trying: card.title,
      employee: employeeRow.name,
      detail: `Composing the message failed: ${written.detail}. Try it again, or say it differently.`,
    });
    return { finished: false, blocked: true, detail: blocked };
  }

  const bullets = bulletsFrom(message, 6);
  const headline = bullets[0] ?? message.slice(0, 160);
  const reasonLine = requesterLine(card, partner);

  const email: ExecEmailInput = {
    employee: employeeRow.name,
    what: card.title,
    tldr: headline,
    sections: [
      { label: "The message", bullets: bullets.length > 0 ? bullets : [message.slice(0, 400)] },
      { label: "Why you're hearing this from me", bullets: [reasonLine] },
    ],
    details: null,
  };

  // 5 · FILE IT — the one door an employee's finished work leaves through. Never modified, never
  // re-implemented: this call is identical in shape to `handOver()` and `runHireSearchCard`'s own.
  const mail = await sendOrPreview(env, {
    to: partner.email,
    email,
    objectType: "work_card",
    objectId: card.id,
    cardKind: PARTNER_MESSAGE_KIND,
    workCardId: card.id,
    cardAsked: card.preview_first === 1 ? true : card.preview_first === 0 ? false : null,
    tickedByFirmUserId: card.preview_owner_id ?? null,
    requestedByEmail: card.requested_by_email ?? null,
    firmScope: card.firm_scope,
    actorId: employeeRow.id,
    what: card.title,
  });

  const delivered = await deliver(env, actor, {
    kind: "employee_finding",
    title: `${employeeRow.name} → ${partner.firstName}: ${card.title}`,
    body: message,
    preparedBy: employeeRow.name,
    preparedFor: partner.firmUserId,
    sourceType: "work_card",
    sourceId: card.id,
  }).catch(() => null);

  const finding = [
    `• ${mail.subject}`,
    mail.sent
      ? `• Emailed to ${partner.email}.`
      : mail.previewed
        ? `• NOT emailed to ${partner.email} — it is preview-first: ${mail.reason}`
        : `• NOT emailed to ${partner.email}: ${mail.reason}.`,
    delivered ? `• Deliverable ${delivered.id}.` : "",
    "",
    message,
  ]
    .filter(Boolean)
    .join("\n");

  await env.WP_OS_DB.prepare(
    "UPDATE work_card SET state = 'DONE', description = substr(COALESCE(description, '') || char(10) || char(10) || ?2, 1, 16000), next_action = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1",
  )
    .bind(card.id, finding)
    .run();

  await appendEvent(env, {
    eventType: "partner_message.delivered",
    actorType: "ai_employee",
    actorId: employeeRow.id,
    objectType: "work_card",
    objectId: card.id,
    firmScope: card.firm_scope,
    payload: { partner: partner.firmUserId, emailed: mail.sent, previewed: mail.previewed, subject: mail.subject },
  });

  return {
    finished: true,
    blocked: false,
    detail: mail.sent
      ? `${mail.subject} — emailed to ${partner.email}`
      : `${mail.subject} — ${mail.reason}`,
  };
}

/** One line saying why this message exists, for the second (mandatory) exec-email section. */
function requesterLine(card: SweepCard, partner: Partner): string {
  const requester = card.requested_by_email ? partnerFor(card.requested_by_email) : null;
  if (requester && requester.firmUserId !== partner.firmUserId) {
    return `${requester.firstName} asked me to pass this to you.`;
  }
  return "I was asked to send you this.";
}
