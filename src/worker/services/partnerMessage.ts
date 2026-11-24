import type { Env } from "../env";
import type { Actor } from "./authorize";
import { runAi } from "../ai/runAi";
import { blockCard } from "./blocks";
import { cannotDetail, steerFor, type Interpreter } from "./instruction";
import { sendOrPreview } from "./previewApproval";
import { deliver } from "./deliverables";
import { appendEvent } from "../events";
import type { SweepCard } from "./workSweep";
import { partnerByEmail, partnerFor, type Partner } from "../../shared/registry/partners";
import { ccOfCard } from "./ccPartners";
import { personaPrompt } from "../../shared/registry/aiEmployeePersonas";
import type { ExecEmailInput } from "../../shared/email/execEmail";

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
  /** The other partner on a "tell both" message: the greeting names both. */
  copy?: Partner | null;
  instruction: string;
  steerText: string;
  askedBy: Partner | null;
}): string {
  const to = input.copy ? `${input.partner.fullName} and ${input.copy.fullName}, the Managing Partners` : `${input.partner.fullName}, a Managing Partner`;
  const hi = input.copy ? `${input.partner.firstName} and ${input.copy.firstName}` : input.partner.firstName;
  return [
    personaPrompt(input.employee, input.role),
    "",
    `You are writing ONE short email to ${to} of West Peek Ventures, as`,
    `${input.employee}, a colleague who works with them every day. It is a note, not a report: warm, plain and specific.`,
    ...(input.askedBy ? [`${input.askedBy.firstName} asked you to reach out; say so in a few natural words ("${input.askedBy.firstName} asked me to get in touch").`] : []),
    "",
    ...(input.steerText ? [input.steerText, ""] : []),
    "WHAT TO TELL THEM, in the words you were given:",
    input.instruction,
    "",
    "Write it now in exactly this shape and nothing else:",
    `SUBJECT: ${input.employee} here: <what the note is about, from its content, under 60 characters>`,
    "",
    `Hi ${hi},`,
    "",
    "<2 to 5 short sentences in your own voice>",
    "",
    input.employee,
    "",
    "Rules: no headings, labels, bullets, bold or TL;DR; never repeat the instruction as the subject; never write",
    '"I was asked to send you this"; never invent a fact, a name, a date, a number or a link you were not given; keep',
    "any link you were given exactly as written.",
  ].join("\n");
}

/** The composed note as the email that goes: its own subject, the body as written. Pure; null when it is not a note. */
export function laidOutNote(written: string, employee: string): { subject: string; text: string; html: string } | null {
  const raw = written.replace(/\r\n/g, "\n").replace(/\*\*/g, "").trim();
  const m = /^\s*SUBJECT:\s*(.+)\n+([\s\S]+)$/i.exec(raw);
  if (!m) return null;
  let subject = m[1]!.replace(/\s+/g, " ").trim();
  const text = m[2]!.trim();
  if (!subject || !text || /^tell\s/i.test(subject.replace(new RegExp(`^${employee}( here)?:\\s*`, "i"), ""))) return null;
  if (!subject.toLowerCase().startsWith(employee.toLowerCase())) subject = `${employee} here: ${subject}`;
  if (subject.length > 90) subject = `${subject.slice(0, 89).replace(/\s+\S*$/, "")}…`;
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = text.split(/\n{2,}/).map((para) => `<p>${esc(para).replace(/\n/g, "<br>")}</p>`).join("\n");
  return { subject, text, html };
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

  /*
   * 2b · BOTH PARTNERS (24 Nov 2026, "an email partner door on all work cards"). A "tell both" card carries the other
   * partner in `cc_emails` (`recordMessageCopy`); the one email goes to `partner` with that partner copied, and the
   * greeting names both. Partner addresses only: `ccList` drops anyone else, and the send door refuses anyone else.
   */
  const copies = (await ccOfCard(env, card.id)).filter((a) => a !== partner.email);
  const copy = copies.length ? partnerByEmail(copies[0]) : null;

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
      chain: `a short message to ${copy ? `${partner.firstName} and ${copy.firstName}` : partner.firstName}`,
      steps: [...PARTNER_MESSAGE_STEPS],
      firmScope: card.firm_scope,
    },
    deps.interpret,
  );
  /*
   * A READER THAT COULD NOT READ IS A FAILED GO, NEVER "THE BRIEF IS MISSING" (2-13 Nov 2026). A seat that was down
   * (Claude "did not say what it understood", Codex unavailable) blocked a Productions card for 11 days asking the
   * partner to repeat himself. The sweep tries again on its next pass, down the route order, and its attempt bound
   * is the named stop. Same rule as productions.ts and productionsHire.ts.
   */
  if (steer.failure) return { finished: false, blocked: false, detail: `what was said about this could not be read: ${steer.failure}` };
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
    copy,
    instruction,
    steerText: steer.text,
    askedBy: askedByOther(card, partner),
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

  /*
   * A NOTE, NOT A STATUS REPORT (20 Nov 2026). The first real ones went out as "Wesley: Tell Sequoia: a short intro"
   * with a TL;DR, a "The message" section and "I was asked to send you this". The employee now writes the subject from
   * the content and the body as a greeting, a few sentences and a sign-off, and it goes laid out exactly as written.
   * A composition that is not in that shape is not sent: the card blocks with the reason rather than a bad email.
   */
  const note = laidOutNote(message, employeeRow.name);
  if (!note) {
    const blocked = await blockCard(env, card, {
      reason: "tried_and_could_not_finish",
      trying: card.title,
      employee: employeeRow.name,
      detail: "The message came back without its own subject and greeting, so it was not sent. Try it again, or say it differently.",
    });
    return { finished: false, blocked: true, detail: blocked };
  }
  const email: ExecEmailInput = { employee: employeeRow.name, what: card.title, tldr: note.subject, sections: [], details: null, laidOut: note };

  // 5 · FILE IT — the one door an employee's finished work leaves through. Never modified, never
  // re-implemented: this call is identical in shape to `handOver()` and `runHireSearchCard`'s own.
  const mail = await sendOrPreview(env, {
    to: partner.email,
    ...(copies.length ? { cc: copies } : {}),
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
    // A message about another job (`from_card_id` at the create door) goes out on that job's own thread.
    replyOnThread: await onThreadOf(env, card.id),
  });

  const delivered = await deliver(env, actor, {
    kind: "employee_finding",
    title: `${employeeRow.name} → ${partner.firstName}: ${card.title}`,
    body: note.text,
    preparedBy: employeeRow.name,
    preparedFor: partner.firmUserId,
    sourceType: "work_card",
    sourceId: card.id,
  }).catch(() => null);

  const finding = [
    `• ${mail.subject}`,
    mail.sent
      ? `• Emailed to ${partner.email}${copies.length ? `, ${copies.join(", ")} copied` : ""}.`
      : mail.previewed
        ? `• NOT emailed to ${partner.email} — it is preview-first: ${mail.reason}`
        : `• NOT emailed to ${partner.email}: ${mail.reason}.`,
    delivered ? `• Deliverable ${delivered.id}.` : "",
    "",
    note.text,
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

/** The thread of the job this message is about (`from_card_id` at the create door), or null for a message of its own. */
async function onThreadOf(env: Env, cardId: string): Promise<string | null> {
  const row = await env.WP_OS_DB.prepare("SELECT request_json FROM work_card WHERE id = ?1").bind(cardId).first<{ request_json: string | null }>();
  let of: unknown = null;
  try {
    of = (JSON.parse(row?.request_json ?? "null") as { on_thread_of?: unknown } | null)?.on_thread_of ?? null;
  } catch {
    of = null;
  }
  return typeof of === "string" && of ? (await import("./requestReply")).threadRootFor(env, of) : null;
}

/** The partner who asked for the message, when it is not the one it goes to. */
function askedByOther(card: SweepCard, partner: Partner): Partner | null {
  const requester = card.requested_by_email ? partnerFor(card.requested_by_email) : null;
  return requester && requester.firmUserId !== partner.firmUserId ? requester : null;
}
