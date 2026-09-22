import type { Env } from "../env";
import type { Actor } from "./authorize";
import { runAi } from "../ai/runAi";
import { personaPrompt } from "../../shared/registry/aiEmployeePersonas";
import { kindHost } from "../../shared/work/kindHosts";

/**
 * WHOEVER OWNS THE KIND ANSWERS FIRST (Addendum 12, 22 Sep 2026).
 *
 * Her question: shouldn't `QUESTION_NEEDS_REPLY` (Addendum 10) try the right AI employee first —
 * "each page has someone who can answer questions about it" — rather than every question landing
 * on her directly? `askLiveHelp`/`askRoom` (`services/liveHelp.ts`, `services/meetingRoom.ts`) are
 * the real, working "ask an AI employee, get a grounded answer" shape in this repo — grounded in
 * the employee's actual persona (`personaPrompt`), never a generic response. Both are meeting-
 * scoped, so this is the same shape lifted out for a card that has no meeting: the persona, the
 * question, a strict answer format, a real model call, nothing invented.
 *
 * THE SAME "WHEN IN DOUBT, DON'T GUESS" POSTURE AS THE INTAKE CLASSIFIER
 * (`webPropertyChange.ts`'s `defaultClassifyActionability`). A wrong guessed answer reaching a
 * partner is worse than the current behaviour of asking her — she is the fallback, and she is
 * always available. So the prompt asks the model to bias hard toward NOT confident, and the parser
 * repeats that bias: anything it cannot read cleanly as "yes, confident" is read as not confident,
 * the same way `parseActionabilityVerdict` reads anything it cannot parse as the safer default.
 *
 * WHAT "CONFIDENCE" MEANS HERE, DECIDED RATHER THAN LEFT OPEN. Not a numeric score — a model
 * inventing "0.82 confident" would be pseudo-precision with nothing behind it, and this repo's own
 * classifier (`ACTIONABILITY_VERDICTS`) already establishes the pattern for a boundary that gates
 * real infrastructure: a categorical, self-reported CONFIDENT: yes|no in a fixed format, read
 * strictly, with the prompt spelling out what "yes" is supposed to mean ("you would stake your name
 * on it"). That is auditable and testable the same way the three-way classifier is; a float would
 * be neither.
 */

export interface QuestionAnswerInput {
  cardId: string;
  firmScope: string;
  /** `work_card.kind` — looked up against `kindHosts.ts`, never assumed by the caller. */
  kind: string | null;
  cardTitle: string;
  /** The partner's own words — the question actually asked. */
  question: string;
}

export interface QuestionAnswerResult {
  /** Null when no kind host is registered, or the registered employee is not ACTIVE. */
  employeeName: string | null;
  employeeId: string | null;
  confident: boolean;
  /** Set only when `confident` is true. */
  answer: string | null;
  /** One short sentence either way — for the audit event and, on escalation, the block detail. */
  reason: string;
  aiRunId: string | null;
}

/** The seam a test proves the ROUTING through, without a model — same shape as `ActionabilityClassifier`. */
export type QuestionAnswerer = (
  env: Env,
  input: QuestionAnswerInput & { employee: { id: string; name: string; role: string } },
) => Promise<{ confident: boolean; answer: string | null; reason: string; aiRunId: string | null }>;

/** Read from the model's fixed answer format. Anything unparseable or "no" reads as not confident. */
export function parseQuestionAnswer(outputText: string | null | undefined): { confident: boolean; answer: string | null; reason: string } {
  const text = (outputText ?? "").trim();
  const confidentMatch = /CONFIDENT:\s*(yes|no)/i.exec(text);
  // Everything after "ANSWER:" up to (never including) a line that starts "REASON:" — greedy
  // whitespace here would swallow the newline that delimits an EMPTY answer from the reason on
  // the next line, which is exactly the malformed-but-confident case this function exists to catch.
  const answerMatch = /ANSWER:([^\n]*(?:\n(?!REASON:)[^\n]*)*)/i.exec(text);
  const reasonMatch = /REASON:\s*(.+)/i.exec(text);
  if (!confidentMatch || confidentMatch[1]!.toLowerCase() !== "yes") {
    return {
      confident: false,
      answer: null,
      reason: (reasonMatch?.[1] ?? (text ? `could not read a confident answer. Raw: "${text.slice(0, 200)}"` : "the model returned nothing")).trim().slice(0, 400),
    };
  }
  const answer = (answerMatch?.[1] ?? "").trim().slice(0, 2000);
  if (!answer) {
    // Said yes but gave nothing to send — treated as not confident. A confident answer with no
    // text is a malformed reply, never something a partner should receive.
    return { confident: false, answer: null, reason: "said confident but gave no answer text — treated as not confident" };
  }
  return { confident: true, answer, reason: (reasonMatch?.[1] ?? "").trim().slice(0, 400) || "(no reason given)" };
}

/** THE DEFAULT ANSWERER — one model call, grounded in the owning employee's real persona. */
const defaultAnswerQuestion: QuestionAnswerer = async (env, input) => {
  const actor: Actor = { type: "AI", aiEmployeeId: input.employee.id, roles: [], firmScopes: [input.firmScope] };
  const { run } = await runAi(env, {
    purpose: `${input.employee.name} tries to answer a partner's question on a ${input.kind ?? "work"} card before it reaches Sequoia`,
    actor,
    inputs: [
      [
        personaPrompt(input.employee.name, input.employee.role),
        "",
        "A partner asked a plain question on a work card in a domain you own. Read it and decide, in " +
          "your own judgement, whether you genuinely know the answer — never guess, never invent a " +
          "fact, a number or a date to appear complete.",
        "",
        `CARD: ${input.cardTitle}`,
        `THE QUESTION, IN THE PARTNER'S OWN WORDS:\n"""\n${input.question.slice(0, 2000)}\n"""`,
        "",
        "BIAS HARD TOWARD NOT CONFIDENT. Sequoia is the fallback and she is always available — a wrong " +
          "guessed answer reaching a partner is worse than her answering it herself. Say CONFIDENT: yes " +
          "only when you would stake your name on the answer exactly as written; anything short of that " +
          "is CONFIDENT: no, whatever the reason.",
        "",
        "Answer in exactly this format and nothing else:",
        "CONFIDENT: yes|no",
        "ANSWER: <your answer, in your own voice, only if confident — omit or leave blank otherwise>",
        "REASON: <one short sentence either way>",
      ].join("\n"),
    ],
    sensitivity: "INTERNAL" as never,
    budgetContext: { judgement: true, expectedOutputTokens: 300 },
    routing: { category: "OPERATIONS", taskClass: "question-routing-answer", workCardId: input.cardId },
  });
  if (run.status !== "COMPLETED" || !run.output_text) {
    return { confident: false, answer: null, reason: `no answer available (${run.failure_reason ?? run.status})`, aiRunId: run.id };
  }
  const parsed = parseQuestionAnswer(run.output_text);
  return { ...parsed, aiRunId: run.id };
};

/**
 * Try the employee who owns this card's KIND before anybody escalates to her.
 *
 * Refuses to try anyone when no kind host is registered, or the registered employee is not
 * ACTIVE — the same "status is not assumed, it comes from the database" rule `pageHosts.ts` holds
 * for a page host. Either way this returns `confident: false` rather than throwing, so the caller's
 * fallback (the existing `a_question_for_you` block) is always the safe default path.
 */
export async function answerQuestionForCard(
  env: Env,
  input: QuestionAnswerInput,
  answer: QuestionAnswerer = defaultAnswerQuestion,
): Promise<QuestionAnswerResult> {
  const host = kindHost(input.kind);
  if (!host) {
    return { employeeName: null, employeeId: null, confident: false, answer: null, reason: `no owning employee is registered for kind "${input.kind ?? "(none)"}"`, aiRunId: null };
  }
  const emp = await env.WP_OS_DB.prepare("SELECT id, name, role, status FROM ai_employee WHERE name = ?1")
    .bind(host.name)
    .first<{ id: string; name: string; role: string; status: string }>();
  if (!emp || emp.status !== "ACTIVE") {
    return {
      employeeName: host.name,
      employeeId: emp?.id ?? null,
      confident: false,
      answer: null,
      reason: emp ? `${emp.name} is ${emp.status.toLowerCase()}, not available to answer` : `nobody named ${host.name} is employed`,
      aiRunId: null,
    };
  }
  const out = await answer(env, { ...input, employee: emp });
  return { employeeName: emp.name, employeeId: emp.id, confident: out.confident, answer: out.confident ? out.answer : null, reason: out.reason, aiRunId: out.aiRunId };
}
