import type { Env } from "../env";
import { json } from "../router";
import type { RouteContext } from "../router";
import { appendEvent } from "../events";
import { actorFromIdentity, authorize } from "./authorize";
import { runAi } from "../ai/runAi";
import { requestTask, runTask } from "./browserTask";
import { searchQuestion } from "./liveSearch";
import { machineForEmployee } from "./attribution";
import { deliver } from "./deliverables";
import { sendOrPreview } from "./previewApproval";
import { leadLine } from "../../shared/deliverables/sections";
import { DELIVERABLE_KINDS, type DeliverableKind } from "../../shared/deliverables/deliverable";
import { PREVIEW_PARTNER, partnerByEmail } from "../../shared/registry/partners";
import { guidanceBlock } from "../../shared/skills/library";
import { writtenGuidance } from "./firmSkills";
import { AI_EMPLOYEE_ROSTER } from "../../shared/registry/aiEmployees";
import { createWorkCardInternal } from "./workCards";
import { blockCard } from "./blocks";
import { seatId } from "../../shared/intake/emailTriggers";
import { buildDesignReviewPrompt } from "../../shared/design/reviewRubric";
import { z } from "zod";
import { ASK_PROMPT_VERSION, buildDraftPrompt, parseAnswer } from "../../shared/work/askToCard";
import { PAGE_PURPOSES } from "../../shared/help/pagePurpose";
import {
  MAX_STEPS,
  MAX_STEPS_PER_CARD,
  buildStepPrompt,
  parseDecision,
  type EmployeeDecision,
  type LoopContext,
} from "../../shared/work/employeeLoop";

/**
 * An AI employee actually working a card (P52).
 *
 * WHAT WAS MISSING. Employees could own work and the browser could be driven, but nothing joined
 * them: every look had to be typed by a partner, so the workforce could hold a task and not move
 * it. This is the loop that lets an employee given a task do what the task takes.
 *
 * FOUR MOVES, AND NO OTHERS. Look something up, write down what it found, say it is stuck, say it
 * is finished. Everything else this system can do to the outside world — sending an email, spending
 * money, changing firm state — keeps its own approval path and does not become reachable because a
 * card exists. A loop whose vocabulary is open is a general agent wearing a work card as a
 * disguise.
 *
 * MID-TASK APPROVAL IS AN OUTCOME, NOT A FAILURE. The operator asked for employees that carry on
 * "even if approval needs to be given mid task". So when a step needs a human the card goes BLOCKED
 * with the question attached and the run stops cleanly; approving it and running again picks up
 * with the full history. The alternative — waiting, retrying, or skipping the step — is how an
 * agent does the easy half of a job and reports it finished.
 *
 * A HUMAN STARTS EACH RUN. Nothing here is autonomous: this executes when somebody presses the
 * button on a card, or when a scheduled job does. The employee decides HOW, never WHETHER.
 *
 * EVERY STEP IS ITS OWN GOVERNED CALL. One model call per step through runAi, so each carries its
 * own cost, provider, privacy label and audit row, and a runaway loop is bounded by MAX_STEPS
 * rather than by hope.
 */

interface CardRow {
  id: string;
  title: string;
  description: string | null;
  next_action: string | null;
  state: string;
  owner_type: string;
  owner_id: string | null;
  allows_browser: number;
  /**
   * WHICH MODELS MAY SEE THIS CARD — and nothing else. PUBLIC_MODEL_APPROVED (the default, and the
   * normal case) or PRIVATE_MODEL_ONLY. Set per card, migration 0184. Independent of `audience`,
   * which decides whether the work previews before it leaves.
   */
  model_access: string;
  prompt: string | null;
  firm_scope: string;
  requested_by_email?: string | null;
  /**
   * WHO THE FINISHED WORK IS FOR. Migration 0183 added this and, until 0196, nothing read it in
   * this path — which is why Parker's October kit finished and reached nobody.
   */
  result_recipient?: string | null;
  /** `work_card.preview_first`. NULL is "nobody said" and the recipient decides. */
  preview_first?: number | null;
  /** Who ticked the box; the preview becomes theirs to answer. */
  preview_owner_id?: string | null;
  kind?: string | null;
  /** Migration 0199. The meeting this card was raised from; Phase C returns the result to it. */
  meeting_id?: string | null;
}

export interface StepOutcome {
  step: number;
  action: string;
  detail: string;
}

/** What has already happened, so a step is chosen knowing the run rather than restarting it. */
/**
 * What the partners have said about this card and have not been answered on.
 *
 * Re-read on EVERY step, because the entire point is that a note left while the work is running
 * lands on the next step rather than after the card closes.
 */
async function unansweredNotes(env: Env, cardId: string): Promise<Array<{ id: string; body: string }>> {
  const rows = await env.WP_OS_DB.prepare(
    `SELECT n.id, n.body, fu.full_name
       FROM work_card_note n
       LEFT JOIN firm_user fu ON fu.id = n.author_id
      WHERE n.work_card_id = ?1 AND n.acknowledged_at IS NULL
      ORDER BY n.created_at ASC`,
  )
    .bind(cardId)
    .all<{ id: string; body: string; full_name: string | null }>();
  return (rows.results ?? []).map((r) => ({ id: r.id, body: `${r.full_name ?? "A partner"}: ${r.body}` }));
}

/**
 * Record what the employee said back, against the notes it was answering.
 *
 * ACKNOWLEDGEMENT AND ANSWER ARE ONE EVENT — the table's CHECK enforces it, so a note cannot be
 * marked seen without saying what it changed. A flag on its own would let an employee dismiss a
 * partner's instruction without it ever touching the work, which is the failure the whole feature
 * exists to prevent.
 */
async function recordAcknowledgement(
  env: Env,
  notes: Array<{ id: string }>,
  output: string,
): Promise<void> {
  const line = output.split("\n").find((l) => l.trim().toUpperCase().startsWith("ACKNOWLEDGED:"));
  if (!line) return;
  const response = line.replace(/^\s*ACKNOWLEDGED:\s*/i, "").trim();
  if (!response) return;
  for (const n of notes) {
    await env.WP_OS_DB.prepare(
      "UPDATE work_card_note SET acknowledged_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), response = ?2 WHERE id = ?1 AND acknowledged_at IS NULL",
    )
      .bind(n.id, response)
      .run();
  }
}

/**
 * WHAT THE FIRM ALREADY HOLDS ON THE COMPANY THE CARD IS ABOUT.
 *
 * 14 Sep 2026: Wyatt's "Deck: Sensori" card was blocked with "the actual deck attachment content
 * was not included in what I received". It had been — the deck was read on 24 August, its sector,
 * one-liner and twenty claims applied to the company record — but the card carried only the email
 * body, and nothing put the company record in front of the employee working the card. Two
 * components each keeping their own list, no link. This is the link: a card titled for a company
 * ("Deck: X", "Deal flow: X", "Scouted: X") gets what the OS knows about X — the record, and the
 * reading of the deck it sent — as the first lines of its history.
 */
export async function companyKnowledge(env: Env, title: string, cardId?: string): Promise<string[]> {
  const company = await companyForTitle(env, title);
  const out: string[] = [];
  if (company) {
    out.push(
      `The firm's record for ${company.canonical_name}: ` +
        [company.sector ? `sector ${company.sector}` : null, company.one_liner, company.website ? `website ${company.website}` : null, company.description]
          .filter(Boolean)
          .join(" · "),
    );
  }
  // THE DECK IS FOUND BY THE COMPANY OR BY THE CARD. An oversize email queues its deck against the
  // routing card it opened and against whatever company the subject named; either link is enough.
  const reading = await env.WP_OS_DB.prepare(
    `SELECT filename, state, applied_json, detail, read_at FROM pending_deck
      WHERE state IN ('READ', 'FAILED') AND (company_id = ?1 OR work_card_id = ?2)
      ORDER BY read_at DESC LIMIT 1`,
  )
    .bind(company?.id ?? "", cardId ?? "")
    .first<{ filename: string; state: string; applied_json: string | null; detail: string | null; read_at: string | null }>();
  if (reading?.state === "FAILED") {
    // "nobody read the deck" is a different fact from "the deck said nothing" — say which.
    out.push(`Their deck (${reading.filename}) arrived but could NOT be read: ${reading.detail ?? "no reason recorded"}. Work from what else you can find and say the deck is unread.`);
  } else if (reading?.applied_json) {
    try {
      const applied = JSON.parse(reading.applied_json) as { claims?: string[]; missing?: string[] };
      if (applied.claims?.length) out.push(`Their deck (${reading.filename}, read ${String(reading.read_at).slice(0, 10)}) claims: ${applied.claims.slice(0, 12).join(" | ")}`);
      if (applied.missing?.length) out.push(`The deck does not say: ${applied.missing.slice(0, 8).join(" | ")}`);
    } catch {
      /* an unreadable reading is simply not history */
    }
  }
  return out;
}

interface CompanyForTitle { id: string; canonical_name: string; website: string | null; sector: string | null; one_liner: string | null; description: string | null }

async function companyForTitle(env: Env, title: string): Promise<CompanyForTitle | null> {
  const m = /^(?:Deck|Deal flow|Scouted):\s*(.+?)(?:\s+Deck)?$/i.exec(title.trim());
  if (!m) return null;
  const name = m[1]!.trim();
  return env.WP_OS_DB.prepare(
    "SELECT id, canonical_name, website, sector, one_liner, description FROM canonical_company WHERE lower(canonical_name) = lower(?1) OR lower(canonical_name) LIKE lower(?2) LIMIT 1",
  )
    .bind(name, `${name}%`)
    .first<CompanyForTitle>();
}

/**
 * A deck that is queued but not yet read is a reason to WAIT, not to work. The sweep runs every
 * five minutes and the reader every fifteen; without this, the employee's first attempt at a deck
 * card lands before the deck has been opened, works from an empty body, and blocks on "the deck
 * PDF never reached me" — which is exactly how Sensori and Vynlo sat BLOCKED for three weeks.
 */
export async function deckStillBeingRead(env: Env, title: string, cardId: string): Promise<{ filename: string } | null> {
  const company = await companyForTitle(env, title);
  return env.WP_OS_DB.prepare(
    "SELECT filename FROM pending_deck WHERE state = 'PENDING' AND (company_id = ?1 OR work_card_id = ?2) LIMIT 1",
  )
    .bind(company?.id ?? "", cardId)
    .first<{ filename: string }>();
}

/** Every other ACTIVE employee, name and role, for the hand-off menu. */
async function colleaguesOf(env: Env, employeeId: string): Promise<Array<{ name: string; role: string }>> {
  const rows = (
    await env.WP_OS_DB.prepare("SELECT name, role FROM ai_employee WHERE status = 'ACTIVE' AND id != ?1 ORDER BY name")
      .bind(employeeId)
      .all<{ name: string; role: string }>()
  ).results ?? [];
  return rows;
}

/**
 * Hand a card to the colleague whose job it is.
 *
 * WHY THIS EXISTS. A partner's emailed request lands on their chief of staff's desk with the
 * instruction "work out who should do this and assign them" — and the employee loop had no way to
 * assign anything. The chief could search, visit, note, block or claim it done; the one thing the
 * brief asked for was the one move not on the menu. So every emailed request was either worked by
 * the wrong seat or blocked back to the partner who sent it.
 *
 * The new card carries the brief in the assigner's words, the original request underneath, who
 * asked (`requested_by_email`, so the answer goes back to them), and where it came from. The
 * assigner's card closes as handed on — its outcome is the hand-off, not the work.
 */
export async function assignCard(
  env: Env,
  card: CardRow,
  by: { id: string; name: string },
  to: string,
  brief: string,
): Promise<{ ok: true; cardId: string; toName: string } | { ok: false; reason: string }> {
  const target = await env.WP_OS_DB.prepare("SELECT id, name, role, status FROM ai_employee WHERE lower(name) = lower(?1) OR id = ?2")
    .bind(to.trim(), seatId(to.trim()))
    .first<{ id: string; name: string; role: string; status: string }>();
  if (!target) return { ok: false, reason: `nobody called "${to}" works here` };
  if (target.id === by.id) return { ok: false, reason: "a card cannot be assigned to the employee who already holds it" };
  if (target.status !== "ACTIVE") return { ok: false, reason: `${target.name} is not employed right now` };
  const created = await createWorkCardInternal(
    env,
    {
      id: `system:assign:${by.id}`,
      email: "work-sweep@joinwestpeek.com",
      fullName: by.name,
      status: "ACTIVE",
      roles: ["MANAGING_PARTNER"],
      authorityScopes: [{ scopeKey: "firm_scope", scopeValue: card.firm_scope }],
    },
    {
      title: brief.split(/\r?\n/)[0]!.slice(0, 90),
      description: [
        `${by.name} handed this to you${card.requested_by_email ? `; it was asked for by ${card.requested_by_email} by email` : ""}.`,
        "",
        "THE BRIEF, in their words:",
        brief,
        "",
        "--- the original request ---",
        (card.description ?? "").slice(0, 4000),
      ].join("\n"),
      owner_type: "AI",
      owner_id: target.id,
      priority: "NORMAL",
      firm_scope: card.firm_scope,
      next_action: brief.slice(0, 300),
      prompt: card.prompt ?? undefined,
    },
  );
  await env.WP_OS_DB.prepare("UPDATE work_card SET requested_by_email = ?2, assigned_from_card_id = ?3 WHERE id = ?1")
    .bind(created.id, card.requested_by_email ?? null, card.id)
    .run();
  await appendEvent(env, {
    eventType: "work_card.assigned",
    actorType: "ai_employee",
    actorId: by.id,
    objectType: "work_card",
    objectId: created.id,
    firmScope: card.firm_scope,
    payload: { from_card: card.id, to: target.id, requested_by_email: card.requested_by_email ?? null },
  });
  return { ok: true, cardId: created.id, toName: target.name };
}

async function historyFor(env: Env, cardId: string): Promise<string[]> {
  // FAILURES CAUSED BY A DEFECT THAT NO LONGER EXISTS ARE NOT HISTORY, THEY ARE NOISE. Early runs
  // drove the browser at DuckDuckGo, which returns a bot challenge; those attempts are still on the
  // record, and feeding them forward taught the employee that searching is impossible — it blocked
  // itself citing rate limits it had not hit. Search-engine URLs are excluded because visiting one
  // was never a real capability, only a bug.
  const looks = ((await env.WP_OS_DB.prepare(
    `SELECT objective, status, result_text, refusal_reason, start_url
       FROM browser_task
      WHERE work_card_id = ?1
        AND start_url NOT LIKE '%duckduckgo.%'
        AND start_url NOT LIKE '%google.com/search%'
        AND start_url NOT LIKE '%bing.com/search%'
      ORDER BY created_at DESC LIMIT 8`,
  )
    .bind(cardId)
    .all<Record<string, unknown>>()).results ?? []).reverse();

  // Searches are recorded on the card itself rather than as browser tasks, so both feed the history.
  return looks.map((l) => {
    if (l.status === "SUCCEEDED" && l.result_text) {
      // Trimmed hard. The full page is on the record; what the next step needs is enough to decide
      // whether the question was answered, not the whole document back in the prompt.
      return `Looked up "${String(l.objective)}" and read: ${String(l.result_text).slice(0, 1200)}`;
    }
    if (l.status === "REQUESTED") return `Asked to look up "${String(l.objective)}" — waiting for a person to approve it.`;
    return `Tried to look up "${String(l.objective)}" and it failed: ${String(l.refusal_reason ?? l.status)}`;
  });
}

/**
 * WHICH KIND OF DELIVERABLE A FINISHED CARD PRODUCES.
 *
 * The card's own kind when it names one the catalogue knows; `employee_finding` otherwise. That
 * default is deliberate and honest: the October card carries `kind = NULL`, so nothing can be
 * inferred from it, and filing it as `research_packet` or `ask_brief` to avoid adding a kind would
 * put a lie in a column that `validate:deliverable-kinds` would then happily accept.
 */
export function deliverableKindForCard(card: { kind?: string | null }): DeliverableKind {
  const k = (card.kind ?? "").toLowerCase();
  return (DELIVERABLE_KINDS as readonly string[]).includes(k) ? (k as DeliverableKind) : "employee_finding";
}

/**
 * WHO THE FILED COPY BELONGS TO. The partner who asked, where the card records an address the
 * registry recognises; otherwise the preview owner; otherwise the firm's managing partner, which is
 * today's behaviour and never nobody. A deliverable with no reader is the bug one step along.
 */
export async function recipientFirmUserId(env: Env, card: Pick<CardRow, "requested_by_email" | "preview_owner_id">): Promise<string> {
  const asked = card.requested_by_email ? partnerByEmail(card.requested_by_email) : null;
  if (asked) return asked.firmUserId;
  if (card.preview_owner_id) return card.preview_owner_id;
  return PREVIEW_PARTNER.firmUserId;
}

/**
 * HAND THE FINISHED WORK TO WHOEVER IT IS FOR.
 *
 * Only when the card names a recipient. A card with nobody named has already been filed by the
 * caller and sits on her Home — that is the whole outcome, and inventing an addressee for it would
 * be worse than doing nothing.
 *
 * THE EMAIL CARRIES THE DECISION AND A LINK, NEVER THE BODY. Her instruction after being shown a
 * 5,621-character kit rendered into a card: "the kit should not arrive on the fucking card, that
 * sounds like hell — maybe a link to an external page". `leadLine` lifts the recommendation, which
 * is the thing she is actually being asked to decide; the document itself stays on the one surface
 * that already holds every kit.
 *
 * NEVER THROWS. The work is already filed by the time this runs. A send that fails must leave a
 * readable deliverable and a recorded reason, not lose the work a second time.
 */
export async function handOver(
  env: Env,
  card: Pick<CardRow, "id" | "title" | "kind" | "firm_scope" | "result_recipient" | "preview_first" | "preview_owner_id" | "requested_by_email">,
  input: { employee: string; finding: string; deliverableId: string | null },
): Promise<void> {
  const to = (card.result_recipient ?? "").trim();
  if (!to) return;
  try {
    await sendOrPreview(env, {
      to,
      email: {
        employee: input.employee,
        what: card.title,
        // The decision she is being asked to make, not the document. `leadLine` lifts the
        // employee's own RECOMMENDED paragraph when there is one.
        tldr: leadLine(input.finding),
        // NO `details`. The body stays on the deliverable surface — a 5,621-character kit in an
        // email is the same wall of text in a different window.
        sections: [
          {
            label: "Where to read it",
            bullets: [
              "On your Home, under what your employees have prepared for you.",
              "It opens as a document — the recommendation first, then the detail.",
            ],
          },
        ],
        details: null,
      },
      objectType: "work_card",
      objectId: card.id,
      firmScope: card.firm_scope,
      cardKind: card.kind ?? null,
      workCardId: card.id,
      cardAsked: card.preview_first === 1 ? true : card.preview_first === 0 ? false : null,
      tickedByFirmUserId: card.preview_owner_id ?? null,
      requestedByEmail: card.requested_by_email ?? null,
      what: card.title,
    });
  } catch (err) {
    await appendEvent(env, {
      eventType: "work_card.handover_failed",
      actorType: "system",
      actorId: "employee_work",
      objectType: "work_card",
      objectId: card.id,
      firmScope: card.firm_scope,
      payload: { to, employee: input.employee, detail: String(err).slice(0, 300) },
    });
  }
}

async function appendFinding(env: Env, card: CardRow, text: string): Promise<void> {
  const next = `${card.description ? `${card.description}\n` : ""}• ${text}`.slice(0, 8000);
  await env.WP_OS_DB.prepare("UPDATE work_card SET description = ?2 WHERE id = ?1").bind(card.id, next).run();
  card.description = next;
}

/**
 * Work a card for up to MAX_STEPS, stopping early when finished or blocked.
 *
 * Never throws at the caller: a card that could not be worked is a card in a state somebody can
 * see, not an exception that loses the run.
 */
export async function workCard(env: Env, ctx: RouteContext, cardId: string, options: { maxSteps?: number } = {}): Promise<{
  card: CardRow | null;
  steps: StepOutcome[];
  finished: boolean;
  blocked: boolean;
  detail: string;
}> {
  const actor = actorFromIdentity(ctx.identity!);
  const steps: StepOutcome[] = [];

  const card = await env.WP_OS_DB.prepare("SELECT * FROM work_card WHERE id = ?1")
    .bind(cardId)
    .first<CardRow>();
  if (!card) return { card: null, steps, finished: false, blocked: false, detail: "no such card" };

  if (card.owner_type !== "AI" || !card.owner_id) {
    return { card, steps, finished: false, blocked: false, detail: "Only a card owned by an employee can be worked this way." };
  }
  if (card.state === "DONE" || card.state === "CANCELLED") {
    return { card, steps, finished: false, blocked: false, detail: `This card is ${card.state.toLowerCase()}.` };
  }

  const employee = await env.WP_OS_DB.prepare("SELECT id, name, role, status FROM ai_employee WHERE id = ?1")
    .bind(card.owner_id)
    .first<{ id: string; name: string; role: string; status: string }>();
  if (!employee) return { card, steps, finished: false, blocked: false, detail: "That employee does not exist." };
  if (employee.status !== "ACTIVE") {
    // An employee who is switched off should not quietly start working. Saying so is the point.
    return { card, steps, finished: false, blocked: false, detail: `${employee.name} is not employed right now — switch them on first.` };
  }

  await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'IN_PROGRESS' WHERE id = ?1 AND state = 'OPEN'")
    .bind(card.id)
    .run();

  // WHOSE WORK THIS IS, for the cost centre. Resolved once rather than per step: the employee does
  // not change mid-run, and this is a lookup against the machine table.
  const machineId = await machineForEmployee(env, employee.name);
  const rosterEntry = AI_EMPLOYEE_ROSTER.find((e) => e.name === employee.name);

  // THE BUDGET IS THE CARD'S, NOT THE RUN'S. `work_steps` counts every step ever taken on this card,
  // so a run that hands the card back unfinished is continued, not restarted, and the employee is
  // made to conclude when the card's allowance is spent — never "five more searches".
  const runSteps = Math.max(1, options.maxSteps ?? MAX_STEPS);
  for (let step = 1; step <= runSteps; step++) {
    const taken = (await env.WP_OS_DB.prepare("SELECT COALESCE(work_steps, 0) AS n FROM work_card WHERE id = ?1").bind(card.id).first<{ n: number }>())?.n ?? 0;
    const leftOnCard = Math.max(1, MAX_STEPS_PER_CARD - taken);
    const leftInRun = runSteps - step + 1;
    const stepsLeft = Math.min(leftOnCard, leftInRun);
    const mustConclude = leftOnCard <= 1;
    const loopCtx: LoopContext = {
      title: card.title,
      next_action: card.next_action,
      description: card.description,
      employee_name: employee.name,
      employee_role: employee.role,
      allows_browser: card.allows_browser === 1,
      prompt: card.prompt,
      // Resolved from where this employee sits, so nothing is assigned by hand and nothing is
      // maintained twice — the roster already says which machines they work.
      //
      // BOTH SOURCES. The reviewed library from the repository, and whatever the partners have
      // since written down and adopted for these machines. A method that is displayed on a page and
      // never reaches a prompt is decoration; this is the line that makes it real.
      guidance: [
        guidanceBlock(rosterEntry?.primaryMachineKeys ?? []),
        await writtenGuidance(env, rosterEntry?.primaryMachineKeys ?? [], actor.firmScopes[0] ?? "west-peek"),
      ]
        .filter((block) => block.length > 0)
        .join("\n"),
      history: [...(await companyKnowledge(env, card.title, card.id)), ...(await historyFor(env, card.id))],
      // Re-read each step: a partner may leave a note while this is already running.
      steering: await unansweredNotes(env, card.id),
      // Everyone else who is employed, so the card can be handed to the seat whose job it is.
      colleagues: await colleaguesOf(env, employee.id),
    };

    const { run } = await runAi(env, {
      purpose: `${employee.name} working "${card.title.slice(0, 60)}" (step ${step})`,
      actor,
      inputs: [buildStepPrompt(loopCtx, mustConclude ? 1 : stepsLeft)],
      // The card and its findings are firm-internal. Never raised: a higher label would let this
      // loop carry confidential material to a provider without anybody deciding that.
      sensitivity: "INTERNAL" as never,
      /*
       * THE TWO LABELS, KEPT APART. `sensitivity: "INTERNAL"` says a partner reads this — it drives
       * preview and approval and it is never raised. `trainingSafe` says what is IN it, which is a
       * different question and the only one that decides which models may see it.
       *
       * Reading the card's own flag rather than the label is the whole of the fix the owner asked
       * for: "ITS NOT DEAL TERMS OR LP INFORMATION SO IT DOESNT MATTER IF ITS USING THIS DATA TO
       * TRAIN. WHO CARES ABOUT HIRING SEARCH AND EVENT KITS AND ROOM KITS." A PUBLIC_MODEL_APPROVED card
       * leads on a free reasoning lane at $0; a PRIVATE_MODEL_ONLY one cannot, and `classifyContent`
       * revokes it anyway if an LP or deal-term marker turns up in the text.
       */
      // The employee CHOOSING ITS NEXT MOVE is the thinking step; it is never downgraded.
      budgetContext: {
        expectedOutputTokens: 400,
        judgement: true,
        ...(card.model_access === "PRIVATE_MODEL_ONLY" ? { confidential: true } : { publicModelApproved: true }),
      },
      // Named, so the run lands on this employee's line in the cost centre and this machine's line
      // on the Machines page. Every run before this was attributed to nobody.
      aiEmployeeId: employee.id,
      routing: {
        category: "OPERATIONS",
        taskClass: "employee-work",
        ...(machineId === null ? {} : { machineId }),
        workCardId: card.id,
      },
    });

    // Recorded before the output is interpreted, so a note is answered even on a step that then
    // fails to produce a usable action — the partner asked a question and it WAS answered.
    if (loopCtx.steering && loopCtx.steering.length > 0 && run.output_text) {
      await recordAcknowledgement(env, loopCtx.steering, run.output_text);
    }

    if (run.status !== "COMPLETED" || !run.output_text) {
      steps.push({ step, action: "failed", detail: run.failure_reason ?? `run ${run.status}` });
      break;
    }

    const decision = parseDecision(run.output_text);
    if (!decision) {
      // Not guessed at. A malformed decision means no action was chosen, and picking one on the
      // employee's behalf — "done" being the cheapest to fake — reports success nobody earned.
      steps.push({ step, action: "unclear", detail: "the employee did not choose a usable action" });
      break;
    }

    await env.WP_OS_DB.prepare("UPDATE work_card SET work_steps = COALESCE(work_steps, 0) + 1 WHERE id = ?1").bind(card.id).run();
    if (mustConclude && decision.action !== "done" && decision.action !== "blocked") {
      // THE LAST STEP IS A CONCLUSION OR NOTHING. An employee told it has one step left and asking
      // for a sixteenth search has not chosen an action the card can take; the sweep hands the
      // card to a person rather than granting the search.
      steps.push({ step, action: "unclear", detail: `the card's ${MAX_STEPS_PER_CARD}-step allowance is spent and the employee asked to ${decision.action} instead of concluding` });
      break;
    }
    const outcome = await applyDecision(env, ctx, card, decision, step, employee.name, employee.id, machineId);
    steps.push(outcome);
    if (outcome.action === "done" || outcome.action === "assigned" || outcome.action === "blocked" || outcome.action === "waiting") break;
  }

  const finished = steps.some((s) => s.action === "done" || s.action === "assigned");
  const blocked = steps.some((s) => s.action === "blocked" || s.action === "waiting");

  await appendEvent(env, {
    eventType: "work_card.worked",
    actorType: "ai_employee",
    actorId: employee.id,
    objectType: "work_card",
    objectId: card.id,
    firmScope: card.firm_scope,
    payload: { steps: steps.length, finished, blocked },
  });

  const fresh = await env.WP_OS_DB.prepare("SELECT * FROM work_card WHERE id = ?1").bind(card.id).first<CardRow>();
  return {
    card: fresh ?? card,
    steps,
    finished,
    blocked,
    detail: finished
      ? `${employee.name} finished it.`
      : blocked
        ? `${employee.name} needs you.`
        : `${employee.name} made progress and stopped after ${steps.length} step${steps.length === 1 ? "" : "s"}.`,
  };
}

async function applyDecision(
  env: Env,
  ctx: RouteContext,
  card: CardRow,
  d: EmployeeDecision,
  step: number,
  /** Who is doing the work. A design review is signed by a person, not by the system. */
  employeeName: string,
  /** And whose cost line it lands on — see services/attribution.ts for why this was all NULL. */
  employeeId: string,
  machineId: number | null,
): Promise<StepOutcome> {
  const actor = actorFromIdentity(ctx.identity!);

  // SEARCH: no page known, so ask live sources rather than driving a browser at a search engine.
  if (d.action === "search") {
    const found = await searchQuestion(env, actor, d.objective!);
    if (!found.ok) return { step, action: "search_failed", detail: found.detail };
    const summary = `Searched "${d.objective}" — ${found.text || "(no answer)"}`.slice(0, 2000);
    await appendFinding(env, card, summary);
    return { step, action: "searched", detail: summary.slice(0, 160) };
  }

  // VISIT: a known page, opened and read. This is what the browser is actually for — checking what
  // a page says now, how it is laid out, whether something has changed.
  if (d.action === "visit") {
    let task;
    try {
      task = await requestTask(env, actor, {
        objective: d.objective!,
        start_url: d.start_url!,
        work_card_id: card.id,
        payment_mode: "NONE",
        max_price_usd: 0,
      } as never);
    } catch (err) {
      return { step, action: "visit_refused", detail: err instanceof Error ? err.message : String(err) };
    }

    if (task.status === "APPROVED") {
      const result = await runTask(env, task.id);
      return { step, action: "visited", detail: `${result.ok ? "Read" : "Could not read"} ${d.start_url}: ${d.objective}` };
    }

    // MID-TASK APPROVAL. The card goes BLOCKED with the question on it and the run stops cleanly;
    // saying yes on the card grants the permission AND puts the work back in the queue, so it
    // resumes with the full history rather than needing a second press somewhere else.
    await blockCard(env, card, {
      reason: "permission_to_open_a_page",
      trying: card.title,
      employee: employeeName,
      url: d.start_url!,
    });
    return { step, action: "waiting", detail: `Needs your approval to open ${d.start_url}` };
  }

  /*
   * LOOK AT: the page as a person sees it.
   *
   * Same governed browser task as a visit — same approval, same allowlist, same record — but the
   * shots are captured and then actually LOOKED AT by a model that can see, through runAi with the
   * images attached. Text alone cannot answer a question about layout, and an employee answering
   * one from `innerText` would be inventing a review of something it never saw.
   *
   * The judgement is written down as a finding on the card, so the operator reads the review where
   * the work is rather than in a run log.
   */
  if (d.action === "look_at") {
    let task;
    try {
      task = await requestTask(env, actor, {
        objective: d.objective!,
        start_url: d.start_url!,
        work_card_id: card.id,
        payment_mode: "NONE",
        max_price_usd: 0,
      } as never);
    } catch (err) {
      return { step, action: "look_refused", detail: err instanceof Error ? err.message : String(err) };
    }

    if (task.status !== "APPROVED") {
      await blockCard(env, card, {
        reason: "permission_to_open_a_page",
        trying: card.title,
        employee: employeeName,
        url: d.start_url!,
      });
      return { step, action: "waiting", detail: `Needs your approval to look at ${d.start_url}` };
    }

    const result = await runTask(env, task.id, undefined, { shots: true });
    if (!result.ok) {
      return { step, action: "looked", detail: `Could not open ${d.start_url}: ${result.detail}` };
    }

    const shots = await loadShots(env, task.id);
    if (shots.length === 0) {
      // NO PICTURES MEANS NO REVIEW. Falling back to judging the text would produce a fluent,
      // plausible review of a layout nobody saw — the exact failure this action exists to prevent.
      const detail = `Opened ${d.start_url} but could not capture a screenshot, so there is nothing to judge the design from. The page text was read and is on the card.`;
      await appendFinding(env, card, detail);
      return { step, action: "looked", detail };
    }

    const { run } = await runAi(env, {
      purpose: `${employeeName} looking at ${d.start_url}`,
      actor,
      inputs: [
        buildDesignReviewPrompt({
          url: result.task.result_url ?? d.start_url!,
          whatTheyAsked: d.objective!,
          reviewerName: employeeName,
          hasDesktop: shots.some((sh) => sh.viewport === "desktop"),
          hasMobile: shots.some((sh) => sh.viewport === "mobile"),
          pageText: (result.task.result_text ?? "").slice(0, 6_000) || null,
        }),
      ],
      images: shots.map((sh) => ({
        mediaType: "image/jpeg",
        dataBase64: sh.base64,
        label: `${sh.viewport} ${sh.width}x${sh.height}`,
      })),
      // A public web page is public. This is what lets the images through the boundary at all —
      // anything the firm holds privately would be labelled higher and refused, by design.
      sensitivity: "PUBLIC" as never,
      // Judging how a page LOOKS is a design opinion, not a lookup.
      budgetContext: { expectedOutputTokens: 1_200, judgement: true },
      aiEmployeeId: employeeId,
      routing: {
        category: "OPERATIONS",
        taskClass: "employee-work",
        ...(machineId === null ? {} : { machineId }),
        workCardId: card.id,
      },
    });

    if (run.status !== "COMPLETED" || !run.output_text) {
      return { step, action: "looked", detail: `Saw ${d.start_url} but could not form a judgement: ${run.failure_reason ?? run.status}` };
    }

    await appendFinding(env, card, run.output_text.slice(0, 4_000));
    return { step, action: "looked", detail: `Looked at ${d.start_url} and wrote up what is wrong with it.` };
  }

  if (d.action === "note") {
    await appendFinding(env, card, d.finding!);
    return { step, action: "noted", detail: d.finding! };
  }

  if (d.action === "assign") {
    const handed = await assignCard(env, card, { id: employeeId, name: employeeName }, d.to!, d.brief!);
    if (!handed.ok) {
      await appendFinding(env, card, `Tried to hand this on: ${handed.reason}.`);
      return { step, action: "noted", detail: `could not hand this on: ${handed.reason}` };
    }
    const line = `Handed to ${handed.toName} as work card ${handed.cardId}: ${d.brief!.slice(0, 300)}`;
    await appendFinding(env, card, line);
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'DONE', next_action = NULL WHERE id = ?1").bind(card.id).run();
    return { step, action: "assigned", detail: line };
  }

  if (d.action === "blocked") {
    // THE EMPLOYEE'S OWN WORDS GO IN `needed`, NOT IN THE EXPLANATION. A question phrased for a
    // person is exactly what belongs under "what would clear it"; the sentence that says the work
    // has stopped is written by the catalogue so it can be held to a standard a model cannot be.
    await blockCard(env, card, {
      reason: "a_question_for_you",
      trying: card.title,
      employee: employeeName,
      detail: d.needs!,
    });
    return { step, action: "blocked", detail: d.needs! };
  }

  // done
  await appendFinding(env, card, d.finding!);
  /*
   * ── FINISHING IS NOT DELIVERING ────────────────────────────────────────────────────────────
   *
   * 18 Sep 2026. Parker finished the October event kit for Kirx Diaz — five COMPLETED runs on a
   * free lane, a real kit with three angles, a recommendation, a run of show, a discussion guide
   * and social drafts. The card then went DONE and produced NOTHING anybody could open: no
   * deliverable, no preview, no email. The kit survived only inside `ai_run.output_text`, because
   * `appendFinding` writes into `work_card.description` and truncates at 8,000 characters — so
   * even the copy on the card was cut off mid-sentence.
   *
   * She had asked for a preview. Her words afterwards: "preview means he was supposed to fucking
   * email me the workshop packet." Rule 0 in this repo's own terms — no stage may exit 0 having
   * done nothing — on the one card she was waiting for.
   *
   * So a finish now does two things it did not do, in this order, and NEITHER can lose the work:
   *
   *   1. FILE IT, in full. The deliverable carries the whole finding, not the truncated card copy.
   *      That alone means a finished card is always something she can open.
   *   2. HAND IT OVER, when the card names somebody. `sendOrPreview` decides send-or-preview by
   *      her rule; a preview is an EMAIL to the owner with the doors on it, which is the shape she
   *      specified ("all previews are supposed to be emailed — that is their shape").
   *
   * THE HANDOVER CANNOT UNDO THE FILING. Delivery is awaited first and the send is wrapped, so an
   * email failure leaves a filed, readable deliverable rather than losing the work a second time.
   * A swallowed failure is what hid the `approval_preview` bug for a day, so it is RECORDED.
   */
  let deliverableId: string | null = null;
  try {
    const filed = await deliver(
      env,
      { type: "SYSTEM", roles: [], firmScopes: [card.firm_scope] },
      {
        kind: deliverableKindForCard(card),
        title: card.title,
        body: d.finding!,
        preparedBy: employeeName,
        preparedFor: await recipientFirmUserId(env, card),
        sourceType: "work_card",
        sourceId: card.id,
      },
    );
    deliverableId = filed.id;
  } catch (err) {
    await appendEvent(env, {
      eventType: "deliverable.not_filed",
      actorType: "system",
      actorId: "employee_work",
      objectType: "work_card",
      objectId: card.id,
      firmScope: card.firm_scope,
      payload: { employee: employeeName, detail: String(err).slice(0, 300) },
    });
  }

  await handOver(env, card, { employee: employeeName, finding: d.finding!, deliverableId });

  /*
   * THE RETURN ADDRESS (Phase C). A card raised from a meeting — pulled in from the live room, or
   * converted from a commitment — sends its result back to that meeting as a block, so the During
   * face shows "done" with the finding under it rather than a chip that never changes. Wrapped
   * like the filing above: a room that cannot be reached must not un-finish the card, and the
   * failure is recorded rather than swallowed.
   */
  if (card.meeting_id) {
    try {
      const { returnCardToRoom } = await import("./meetingRoom");
      await returnCardToRoom(env, card.id, { employee: employeeName, finding: d.finding!, deliverableId });
    } catch (err) {
      await appendEvent(env, {
        eventType: "meeting.room_return_failed",
        actorType: "system",
        actorId: "employee_work",
        objectType: "work_card",
        objectId: card.id,
        firmScope: card.firm_scope,
        payload: { meeting_id: card.meeting_id, detail: String(err).slice(0, 300) },
      });
    }
  }

  await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'DONE', next_action = NULL WHERE id = ?1")
    .bind(card.id)
    .run();
  return { step, action: "done", detail: d.finding! };
}

/** POST /api/work-cards/:id/work — have the employee who owns this card get on with it. */
export async function handleWorkCard(ctx: RouteContext): Promise<Response> {
  const cardId = ctx.params.id;
  if (!cardId) return json({ error: "invalid_input" }, { status: 400 });

  const actor = actorFromIdentity(ctx.identity!);
  // A person starts the run. The employee decides HOW, never WHETHER.
  if (actor.type !== "HUMAN") {
    return json({ error: "human_required", detail: "A person starts a run." }, { status: 403 });
  }
  const authz = await authorize(ctx.env, actor, "ai.run", { objectType: "work_card", objectId: cardId });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });

  const out = await workCard(ctx.env, ctx, cardId);
  return json(out, { status: out.card ? 200 : 404 });
}

const askSchema = z.object({ text: z.string().trim().min(8).max(4000) });

/**
 * POST /api/intent/draft — turn a sentence into a work card the partner can read and accept.
 *
 * WRITES NOTHING. The draft comes back, the partner reads it, and pressing Add creates the card
 * through the ordinary path. A front door that silently fills the board teaches people to stop
 * typing into it.
 *
 * The prompt is drafted here because the employees are LLM-powered and the instruction is usually
 * the difference between work done well and work done plausibly — and because almost nobody writes
 * one from a blank field. A prompt field that stays empty is the same as not having one.
 */
export async function handleDraftCard(ctx: RouteContext): Promise<Response> {
  const parsed = askSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });

  const actor = actorFromIdentity(ctx.identity!);
  const authz = await authorize(ctx.env, actor, "work_card.create", { objectType: "work_card" });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });

  // Only employees who are actually employed. Suggesting somebody switched off produces a card that
  // cannot be worked and looks assigned.
  const roster = ((await ctx.env.WP_OS_DB.prepare(
    "SELECT id, name, role FROM ai_employee WHERE status = 'ACTIVE' ORDER BY name",
  ).all<{ id: string; name: string; role: string }>()).results ?? []);

  const { run } = await runAi(ctx.env, {
    purpose: "drafting a work card from a request",
    actor,
    // The page registry is the routing table. It already states what each page is for, in the
    // operator's own words, so "where do I see what we have spent" has an answer without anybody
    // maintaining a second list that would drift from the first.
    inputs: [
      buildDraftPrompt(
        parsed.data.text,
        roster.map((r) => ({ name: r.name, role: r.role })),
        Object.entries(PAGE_PURPOSES).map(([key, p]) => ({ key, purpose: p.purpose })),
      ),
    ],
    // The request is firm-internal — it can name a company, a partner, a deal.
    sensitivity: "INTERNAL" as never,
    // Reading what the partner meant and writing the card is the interpretation step itself.
    budgetContext: { expectedOutputTokens: 900, judgement: true },
    routing: { category: "OPERATIONS", taskClass: "employee-work" },
  });

  if (run.status !== "COMPLETED" || !run.output_text) {
    return json({ error: "draft_failed", detail: run.failure_reason ?? `run ${run.status}`, run_id: run.id }, { status: 502 });
  }

  const answer = parseAnswer(run.output_text, new Set(Object.keys(PAGE_PURPOSES)));
  if (!answer) {
    return json({ error: "unreadable", detail: "could not work out what that needs", run_id: run.id }, { status: 502 });
  }

  // Resolve a suggested name to a real employee, or leave it unassigned. A name matching nobody
  // employed is dropped rather than shown: a wrong owner looks decided.
  const card = answer.card
    ? (() => {
        const owner = roster.find((r) => r.name.toLowerCase() === (answer.card!.suggested_owner ?? "").toLowerCase()) ?? null;
        return { ...answer.card, owner_id: owner?.id ?? null, owner_name: owner?.name ?? null };
      })()
    : null;

  return json({
    outcome: answer.outcome,
    says: answer.says,
    page: answer.page ?? null,
    draft: card,
    run_id: run.id,
    prompt_version: ASK_PROMPT_VERSION,
    note:
      answer.outcome === "WORK"
        ? "Nothing has been created. Read it, change anything, then add it."
        : answer.outcome === "GO"
          ? "This already exists — no work needed."
          : "",
  });
}

/**
 * Pull a task's screenshots back out of R2, as base64 ready for the model.
 *
 * WHY BASE64 AND NOT A URL. A hosted link would mean the provider fetching from us, which is an
 * inbound path this system does not have and does not want. The bytes travel with the request,
 * through the same governed boundary as everything else.
 *
 * A shot whose bytes have gone missing is skipped rather than failing the review — one viewport is
 * a worse review than two, and no review at all is worse than both.
 */
async function loadShots(
  env: Env,
  taskId: string,
): Promise<Array<{ viewport: string; width: number; height: number; base64: string }>> {
  const rows = ((await env.WP_OS_DB.prepare(
    "SELECT viewport, width, height, r2_key FROM browser_task_shot WHERE task_id = ?1 ORDER BY viewport DESC",
  ).bind(taskId).all<{ viewport: string; width: number; height: number; r2_key: string }>()).results ?? []);

  const bucket = env.WP_OS_DOCUMENTS;
  if (!bucket) return [];

  const out: Array<{ viewport: string; width: number; height: number; base64: string }> = [];
  for (const row of rows) {
    try {
      const obj = await bucket.get(row.r2_key);
      if (!obj) continue;
      const bytes = new Uint8Array(await obj.arrayBuffer());
      let binary = "";
      // Chunked: String.fromCharCode with a few hundred thousand arguments blows the stack.
      for (let i = 0; i < bytes.length; i += 8192) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      }
      out.push({ viewport: row.viewport, width: row.width, height: row.height, base64: btoa(binary) });
    } catch {
      // This shot is unreadable. The others still stand.
    }
  }
  return out;
}

const writeBriefSchema = z.object({
  title: z.string().trim().min(3).max(160),
  question: z.string().trim().min(5).max(600),
  author: z.string().trim().max(80).optional(),
});

/**
 * POST /api/intent/brief — research a question and hand back a written document.
 *
 * THIS IS WHAT THE WORK-PACKET FLOW ALWAYS WAS. That flow was built first, wears builder vocabulary
 * — lens stack, acceptance criteria, output definition, enhancement strength — and has produced
 * exactly zero packets, because no partner has ever thought in those words. Same idea, asked for
 * the way somebody would actually ask, and delivered the way everything else here is delivered:
 * signed by a named employee, filed in Documents, downloadable, emailable, on the Home page of
 * whoever asked.
 *
 * WHY IT IS NOT A WORK CARD. A card is work somebody CARRIES — an owner, a next action, a place on
 * a board until it is done. A brief is something you asked for and receive. Putting one on the
 * board fills it with questions wearing deadlines, which is how a board stops being read.
 *
 * SIGNED BY THE AUTHOR, not by a Chief of Staff. The morning brief and the weekly agenda are
 * firm-wide things assembled by machinery, which is why they need a person attached. A brief has an
 * author already — usually Wyatt, since most of these are research — and routing his own writing
 * through somebody else's byline would be the anonymity problem in reverse.
 */
export async function handleWriteBrief(ctx: RouteContext): Promise<Response> {
  const parsed = writeBriefSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });

  const actor = actorFromIdentity(ctx.identity!);

  /*
   * THIS HANDLER HAD NO AUTHORIZATION CHECK AT ALL.
   *
   * Every sibling has one — `handleDraftCard` gates on `work_card.create`, `handleWorkCard` on
   * `ai.run` — and `runAi` does not authorize either, so nothing stood between any authenticated
   * identity and an unbounded AI run that files a document signed in an employee's name. That
   * includes `fu_browser_agent`, the read-only service account with no roles, which the browser
   * automation presents.
   *
   * `ai.run` is the right key: what this does is commission a model call and keep the output. The
   * governing rule is one authorization choke point and no exceptions, and this was an exception.
   */
  const authz = await authorize(ctx.env, actor, "ai.run", { objectType: "deliverable", firmScope: actor.firmScopes[0] });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });

  /*
   * AND A ROLE GATE, because the choke point alone does not close this.
   *
   * `ai.run` is neither reserved nor an external effect, so `authorize` allows it for any
   * authenticated identity — including `fu_browser_agent`, the read-only service account with no
   * roles that a Cloudflare Access service token resolves to. The choke point above is still right
   * and belongs there; it is simply not a role check, and this handler needs one.
   *
   * What it commissions is an unbounded model call whose output is FILED as a firm document signed
   * in an employee's name. The prompt below says so in its own words — "A Managing Partner has
   * asked for a written brief" — and that should be true rather than assumed.
   */
  if (!actor.roles.includes("MANAGING_PARTNER")) {
    return json(
      {
        error: "forbidden",
        detail: "A brief is commissioned by a Managing Partner. It spends money and is filed as a firm document signed by an employee.",
      },
      { status: 403 },
    );
  }

  const input = parsed.data;

  const roster = ((await ctx.env.WP_OS_DB.prepare(
    "SELECT id, name, role FROM ai_employee WHERE status = 'ACTIVE' ORDER BY name",
  ).all<{ id: string; name: string; role: string }>()).results ?? []);

  // The named author if they are employed and switched on, else whoever owns research. A brief
  // signed by somebody who does not work here would be the worst kind of attribution.
  const author =
    roster.find((r) => r.name.toLowerCase() === (input.author ?? "").toLowerCase()) ??
    roster.find((r) => r.name === "Wyatt") ??
    roster[0];
  if (!author) {
    return json(
      { error: "nobody_employed", detail: "No AI employee is switched on, so nobody can write this. Activate one on Team → Employees." },
      { status: 409 },
    );
  }

  const machineId = await machineForEmployee(ctx.env, author.name);
  const rosterEntry = AI_EMPLOYEE_ROSTER.find((e) => e.name === author.name);

  const { run } = await runAi(ctx.env, {
    purpose: `${author.name} writing a brief: ${input.title.slice(0, 60)}`,
    actor,
    inputs: [
      [
        `You are ${author.name}, ${author.role} at West Peek Ventures, an earliest-stage venture fund.`,
        "A Managing Partner has asked for a written brief. Write it.",
        "",
        `TITLE: ${input.title}`,
        `THE QUESTION IT ANSWERS: ${input.question}`,
        "",
        // The department's own methods, so a brief reflects how this firm works rather than how
        // any firm works. See shared/skills/library.ts, plus anything the partners have written
        // down and adopted since.
        guidanceBlock(rosterEntry?.primaryMachineKeys ?? []),
        await writtenGuidance(ctx.env, rosterEntry?.primaryMachineKeys ?? [], actor.firmScopes[0] ?? "west-peek"),
        "HOW TO WRITE IT:",
        "- Answer the question in the first two sentences. Everything after that is support.",
        "- Say plainly what you do NOT know. An absence you name is a finding; one you skip past",
        "  reads as a claim that nothing was there.",
        "- Never invent a figure, a date, a company or a quote. If you are reasoning rather than",
        "  reporting, say which it is.",
        "- Markdown headings, short sections. A partner reads this on a phone before a meeting.",
        "- No preamble, no restating the question back, no sign-off — it is signed already.",
        "",
        "Write the brief.",
      ].filter((l) => l !== "").join("\n"),
    ],
    // The question can name a company, a partner, a deal.
    sensitivity: "INTERNAL" as never,
    // A brief with a partner's name on it.
    budgetContext: { judgement: true, expectedOutputTokens: 1_800 },
    aiEmployeeId: author.id,
    routing: {
      category: "RESEARCH",
      taskClass: "employee-work",
      ...(machineId === null ? {} : { machineId }),
    },
  });

  if (run.status !== "COMPLETED" || !run.output_text) {
    return json({ error: "brief_failed", detail: run.failure_reason ?? `run ${run.status}`, run_id: run.id }, { status: 502 });
  }

  const delivered = await deliver(ctx.env, actor, {
    kind: "ask_brief",
    title: input.title,
    body: run.output_text,
    preparedBy: author.name,
    preparedFor: ctx.identity!.id,
    sourceType: "ai_run",
    sourceId: run.id,
  });

  return json(
    {
      deliverable_id: delivered.id,
      title: delivered.title,
      prepared_by: delivered.prepared_by,
      filed: Boolean(delivered.document_id),
      run_id: run.id,
      note: `${author.name} wrote it. It is on your Home page under “Prepared for you”, and in Documents.`,
    },
    { status: 201 },
  );
}
