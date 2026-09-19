import type { RouteContext } from "../router";
import { json } from "../router";
import { actorFromIdentity, authorize } from "./authorize";
import { runAi } from "../ai/runAi";
import { pageHost } from "../../shared/help/pageHosts";
import { pagePurpose } from "../../shared/help/pagePurpose";
import { pageGuide } from "../../shared/help/pageGuide";
import { guideIntent, renderGuideMarkdown, renderIntentAnswer, renderWalkthroughMarkdown } from "../../shared/help/pageGuide/render";
import { guidanceBlock } from "../../shared/skills/library";
import { personaFor } from "../../shared/registry/aiEmployeePersonas";

/**
 * Asking the person who runs this page.
 *
 * Operator, item 14: an AI chat panel on every page, top right. Item 8 gave 17 pages a named host
 * with their picture, title and machines. A face with no way to speak to it is a poster.
 *
 * WHO ANSWERS IS NOT A CHOICE THE PARTNER MAKES, and that is the whole point of the feature. The
 * host of the page answers, because the question a partner has on a page is almost always about
 * what that page is for, and making them first pick an employee out of the whole roster is
 * asking them to know the org chart before they can ask a question. `pageHosts.ts` already holds
 * the assignment and a test reads the real nav out of App.tsx, so there is no second list to drift.
 *
 * THEY MUST ACTUALLY BE EMPLOYED. The host card already refuses to smile over a page nobody is
 * working; the panel has to hold the same line or it is worse — a card that says "switched off"
 * above a box that answers anyway teaches a partner the status is decorative. An INACTIVE host
 * declines, in their own name, and says where the switch is.
 *
 * WHAT THEY KNOW WHEN THEY ANSWER. Three things, all read from registries rather than written here:
 * what the page is for (`pagePurpose`), what the firm's own methods are for their machines
 * (`guidanceBlock` — item 17's veteran standard, which had reached 2 of ~27 call sites), and their
 * own voice (`personaFor`). None of it is duplicated into a prompt string, so amending a skill
 * changes what they say.
 *
 * WHAT THEY CANNOT DO. Answer, and nothing else. No tool, no write, no spend beyond the run itself,
 * no email — `aiOutbound.ts` governs that and is not consulted here because nothing here sends
 * anything. A partner who wants work done presses the control on the page; this box explains which
 * control that is.
 *
 * "HOW DOES THIS PAGE WORK" IS NOT A MODEL QUESTION. Owner, 19 Sep 2026, after asking Walter on
 * Meetings: "I can't understand anything he said — it's all jumbled … I think he still has the old
 * page instructions." Both halves were true. The prompt carried `pagePurpose`, which still described
 * the page before that week's redesign, and the model paraphrased it into one paragraph. So for
 * this one question the answer is the page's GUIDE (`pageGuide/`), rendered verbatim — a fixed
 * shape, held to the page by `validate:page-guides`, with no model in the loop to paraphrase it
 * and nothing to spend. Every other question still goes to the model, but with the same guide as
 * its only description of the page, and a format it may not depart from.
 */

/** Long enough to be a question, short enough that the box is not a document editor. */
const MAX_MESSAGE = 1200;

/** Thirty turns of history, the same window the research 1:1 carries. */
const HISTORY_TURNS = 30;

function readerName(ctx: RouteContext): string | undefined {
  const id = ctx.identity;
  if (!id) return undefined;
  const named = id as unknown as { full_name?: string; fullName?: string; name?: string };
  return named.full_name ?? named.fullName ?? named.name;
}

/** The thread, oldest first — it is read as a conversation, not as a log. */
export async function handlePageThread(ctx: RouteContext): Promise<Response> {
  const navKey = ctx.params.navKey!;
  const host = pageHost(navKey, readerName(ctx));
  if (!host) return json({ error: "not_found", detail: "No employee hosts this page." }, { status: 404 });

  const turns = (
    await ctx.env.WP_OS_DB.prepare(
      `SELECT id, turn_no, role, body, state, detail, created_at
         FROM page_turn WHERE nav_key = ?1 AND firm_user_id = ?2 ORDER BY turn_no ASC`,
    )
      .bind(navKey, ctx.identity!.id)
      .all()
  ).results ?? [];

  return json({ host: { name: host.name, role: host.role }, turns });
}

export async function handlePageReply(ctx: RouteContext): Promise<Response> {
  const navKey = ctx.params.navKey!;
  const body = (await ctx.request.json().catch(() => null)) as { message?: unknown } | null;
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  if (message.length < 2) return json({ error: "invalid_input", detail: "Ask something." }, { status: 400 });
  if (message.length > MAX_MESSAGE) {
    return json({ error: "invalid_input", detail: "That is long enough to be a document. Ask the shorter version." }, { status: 400 });
  }

  const host = pageHost(navKey, readerName(ctx));
  if (!host) return json({ error: "not_found", detail: "No employee hosts this page." }, { status: 404 });

  const actor = actorFromIdentity(ctx.identity!);
  const authz = await authorize(ctx.env, actor, "ai.run", { objectType: "page_thread", objectId: navKey });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });

  // Live employment, read now rather than trusted from the roster. The roster says who it WOULD be.
  const employed = await ctx.env.WP_OS_DB.prepare(
    "SELECT status FROM ai_employee WHERE name = ?1",
  )
    .bind(host.name)
    .first<{ status: string }>();

  /*
   * THE LAST THIRTY TURNS, NOT THE FIRST THIRTY.
   *
   * `ORDER BY turn_no ASC LIMIT 30` takes the OLDEST thirty, so once a thread passed its thirtieth
   * turn the host was handed the OPENING of the conversation for ever and never saw anything recent
   * — while the partner reads the whole thread on screen, because `handlePageThread` has no limit.
   * The symptom is an employee who slowly stops following what is being said and starts answering
   * a question from last week, which reads as a bad model rather than as a bad query.
   *
   * Taken newest-first and turned back the right way round, so the model still reads it in order.
   */
  const priorTurns = (
    (
      await ctx.env.WP_OS_DB.prepare(
        `SELECT role, body FROM page_turn
          WHERE nav_key = ?1 AND firm_user_id = ?2 AND state = 'OK' ORDER BY turn_no DESC LIMIT ?3`,
      )
        .bind(navKey, ctx.identity!.id, HISTORY_TURNS)
        .all<{ role: string; body: string }>()
    ).results ?? []
  ).reverse();

  // Turn numbers count every turn, not the OK ones — a failed turn stays in the thread and must
  // keep its place, or the next reply collides with it on the UNIQUE constraint.
  const used = await ctx.env.WP_OS_DB.prepare(
    "SELECT COALESCE(MAX(turn_no), 0) AS n FROM page_turn WHERE nav_key = ?1 AND firm_user_id = ?2",
  )
    .bind(navKey, ctx.identity!.id)
    .first<{ n: number }>();
  const nextNo = (used?.n ?? 0) + 1;

  await ctx.env.WP_OS_DB.prepare(
    "INSERT INTO page_turn (id, nav_key, firm_user_id, turn_no, role, body) VALUES (?1, ?2, ?3, ?4, 'PARTNER', ?5)",
  )
    .bind(`pt_${crypto.randomUUID()}`, navKey, ctx.identity!.id, nextNo, message)
    .run();

  // The refusal is a recorded turn in their own voice, not an error toast. A partner who asks a
  // switched-off employee a question deserves to see that they asked and why nothing came back.
  if (employed?.status !== "ACTIVE") {
    const why = employed
      ? `${host.name} is ${employed.status.toLowerCase()}, so nobody is working this page yet. Employ them on Employees and ask again.`
      : `${host.name} is not set up in this system yet, so there is nobody to answer here.`;
    await ctx.env.WP_OS_DB.prepare(
      "INSERT INTO page_turn (id, nav_key, firm_user_id, turn_no, role, body, state, detail) VALUES (?1, ?2, ?3, ?4, 'SYSTEM', ?5, 'REFUSED', ?6)",
    )
      .bind(`pt_${crypto.randomUUID()}`, navKey, ctx.identity!.id, nextNo + 1, why, employed?.status ?? "NOT_SEATED")
      .run();
    return json({ ok: false, reply: null, detail: why });
  }

  const guide = pageGuide(navKey);

  /*
   * THREE QUESTIONS, ANSWERED FROM THE GUIDE VERBATIM, with no run behind them: "how does this page
   * work" (the guide), "walk me through a real meeting" (the walkthrough), "explain what all of the
   * buttons do" (the acts by band). The owner asked Walter for the second on 19 Sep 2026 and got a
   * model's memory of the page that skipped the seating screen. `detail` names which shape was
   * spoken — GUIDE, WALKTHROUGH or BUTTONS — so a reader of the thread table can tell a spoken
   * guide from a model turn; `source: "guide"` says the same to the client.
   */
  const intent = guide ? guideIntent(message) : null;
  if (guide && intent) {
    const reply = renderIntentAnswer(guide, intent);
    const spoken = intent === "how" ? "GUIDE" : intent === "walkthrough" ? "WALKTHROUGH" : "BUTTONS";
    await ctx.env.WP_OS_DB.prepare(
      "INSERT INTO page_turn (id, nav_key, firm_user_id, turn_no, role, body, state, detail) VALUES (?1, ?2, ?3, ?4, 'HOST', ?5, 'OK', ?6)",
    )
      .bind(`pt_${crypto.randomUUID()}`, navKey, ctx.identity!.id, nextNo + 1, reply, spoken)
      .run();
    return json({ ok: true, reply, detail: null, source: "guide", shape: intent });
  }

  const purpose = pagePurpose(navKey);
  const guidance = guidanceBlock(host.machineKeys);
  const persona = personaFor(host.name);

  const { run } = await runAi(ctx.env, {
    purpose: `Page 1:1 on ${navKey}`,
    actor,
    inputs: [
      [
        `You are ${host.name}, ${host.role} at West Peek, an early-stage venture fund. A Managing`,
        "Partner is standing on the page you are responsible for and has asked you something.",
        persona?.voice ? `How you come across: ${persona.voice}` : "",
        "",
        `WHY THIS PAGE IS YOURS: ${host.because}`,
        guide
          ? [
              "THE PAGE, AS IT IS TODAY. This is the only description of the page you have, and it is",
              "kept true to the page by a build check. Every band and every control named below exists;",
              "nothing else does. Never name a control, tab, band or step that is not in it.",
              "",
              renderGuideMarkdown(guide),
              "",
              "HOW A PARTNER WOULD USE IT, START TO FINISH — the only sequence of steps you may describe:",
              "",
              renderWalkthroughMarkdown(guide),
            ].join("\n")
          : purpose
            ? `WHAT THIS PAGE IS FOR: ${purpose.purpose}\nWHAT THEY CAN DO HERE: ${purpose.youCan.join("; ")}.`
            : "",
        "",
        guidance,
        "",
        "ANSWER FROM TWENTY YEARS OF DOING THIS. Not from a manual — from having run it. If they ask",
        "what a number means, say what it means and what a bad one looks like. If they ask what to do",
        "next, say what you would do and why, and name the control on this page that does it.",
        "",
        "YOU CAN ONLY TALK. You have no button here: you cannot approve, send, spend, email or file",
        "anything. When the answer is an action, say which control on this page performs it and let",
        "them press it. Never imply you have done something.",
        "",
        "DO NOT INVENT THE FIRM'S DATA. You are not being shown the records on this page. If the",
        "answer depends on what is actually recorded, say that you are answering generally and tell",
        "them where on the page to read the real figure. A confident made-up number is the single",
        "worst thing you can produce here.",
        "",
        "HOW TO WRITE IT. Markdown, in this shape and no other: one line that answers, then numbered",
        "steps or short bullets, never a paragraph; the name of every control in **bold**, exactly as",
        "it is written on the page; at most twelve lines; readable on a phone. Short. Direct. No",
        "preamble, no restating their question, no offers to help further, and do not end with a",
        "question back to them.",
        "",
        priorTurns.length > 0 ? "The conversation so far:" : "",
        ...priorTurns.map((t) => `${t.role === "PARTNER" ? "Partner" : "You"}: ${t.body}`),
        `Partner: ${message}`,
      ]
        .filter((line) => line !== "")
        .join("\n"),
    ],
    sensitivity: "INTERNAL" as never,
    budgetContext: { judgement: true, expectedOutputTokens: 500 },
    // OPERATIONS, not a category invented to fit. `ai_run_attribution.category` has a CHECK
    // constraint (PROACTIVE/RESEARCH/LEGAL/COMPLIANCE/OPERATIONS/INTELLIGENCE/OTHER) and
    // routing.ts writes that row with INSERT OR IGNORE — so a category outside the list is not
    // rejected, it is silently dropped, and this run would have gone unattributed forever with
    // nothing anywhere saying why. Explaining the firm's own machinery to a partner is operations.
    routing: { category: "OPERATIONS", taskClass: "page_conversation" },
  });

  const ok = run.status === "COMPLETED" && Boolean(run.output_text);
  await ctx.env.WP_OS_DB.prepare(
    "INSERT INTO page_turn (id, nav_key, firm_user_id, turn_no, role, body, state, detail, ai_run_id) VALUES (?1, ?2, ?3, ?4, 'HOST', ?5, ?6, ?7, ?8)",
  )
    .bind(
      `pt_${crypto.randomUUID()}`,
      navKey,
      ctx.identity!.id,
      nextNo + 1,
      ok ? run.output_text! : `${host.name} could not answer that just now.`,
      ok ? "OK" : "FAILED",
      ok ? null : (run.failure_reason ?? `run ${run.status}`),
      run.id,
    )
    .run();

  return json({ ok, reply: ok ? run.output_text : null, detail: ok ? null : run.failure_reason });
}
