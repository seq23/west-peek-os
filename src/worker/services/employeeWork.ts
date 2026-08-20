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
import { guidanceBlock } from "../../shared/skills/library";
import { AI_EMPLOYEE_ROSTER } from "../../shared/registry/aiEmployees";
import { buildDesignReviewPrompt } from "../../shared/design/reviewRubric";
import { z } from "zod";
import { ASK_PROMPT_VERSION, buildDraftPrompt, parseAnswer } from "../../shared/work/askToCard";
import { PAGE_PURPOSES } from "../../shared/help/pagePurpose";
import {
  MAX_STEPS,
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
  prompt: string | null;
  firm_scope: string;
}

export interface StepOutcome {
  step: number;
  action: string;
  detail: string;
}

/** What has already happened, so a step is chosen knowing the run rather than restarting it. */
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
export async function workCard(env: Env, ctx: RouteContext, cardId: string): Promise<{
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

  for (let step = 1; step <= MAX_STEPS; step++) {
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
      guidance: guidanceBlock(rosterEntry?.primaryMachineKeys ?? []),
      history: await historyFor(env, card.id),
    };

    const { run } = await runAi(env, {
      purpose: `${employee.name} working "${card.title.slice(0, 60)}" (step ${step})`,
      actor,
      inputs: [buildStepPrompt(loopCtx, MAX_STEPS - step + 1)],
      // The card and its findings are firm-internal. Never raised: a higher label would let this
      // loop carry confidential material to a provider without anybody deciding that.
      sensitivity: "INTERNAL" as never,
      budgetContext: { expectedOutputTokens: 400 },
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

    const outcome = await applyDecision(env, ctx, card, decision, step, employee.name, employee.id, machineId);
    steps.push(outcome);
    if (outcome.action === "done" || outcome.action === "blocked" || outcome.action === "waiting") break;
  }

  const finished = steps.some((s) => s.action === "done");
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
    // approving and running again resumes with the full history.
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'BLOCKED', next_action = ?2 WHERE id = ?1")
      .bind(card.id, `Waiting on your approval to open ${d.start_url}`)
      .run();
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
      await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'BLOCKED', next_action = ?2 WHERE id = ?1")
        .bind(card.id, `Waiting on your approval to look at ${d.start_url}`)
        .run();
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
      budgetContext: { expectedOutputTokens: 1_200 },
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

  if (d.action === "blocked") {
    await env.WP_OS_DB.prepare(
      "UPDATE work_card SET state = 'BLOCKED', next_action = ?2 WHERE id = ?1",
    )
      .bind(card.id, d.needs!)
      .run();
    return { step, action: "blocked", detail: d.needs! };
  }

  // done
  await appendFinding(env, card, d.finding!);
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
    budgetContext: { expectedOutputTokens: 900 },
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

  const actor = actorFromIdentity(ctx.env ? ctx.identity! : ctx.identity!);
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
        // any firm works. See shared/skills/library.ts.
        guidanceBlock(rosterEntry?.primaryMachineKeys ?? []),
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
    budgetContext: { expectedOutputTokens: 1_800 },
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
