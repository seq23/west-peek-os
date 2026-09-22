import type { Env } from "../env";
import { appendEvent } from "../events";
import { runAi } from "../ai/runAi";
import type { Actor } from "./authorize";
import { partnerByEmail } from "../../shared/registry/partners";
import { chiefOfStaffFor } from "../../shared/work/chiefOfStaff";
import { EMPLOYEE_PERSONAS, INTAKE_JUDGMENT_STANDARD } from "../../shared/registry/aiEmployeePersonas";
import { seatId } from "../../shared/intake/emailTriggers";
import { WEB_PROPERTY_CHANGE_KIND } from "../../shared/work/localJobs";
import { sendPartnerEmail } from "./execEmail";
import type { WebPropertyChangeCard } from "./webPropertyChange";

/**
 * ADDENDUM 11 / 11.1 (22 Sep 2026): THE CHIEFS OF STAFF BANTER BACK, JUDGEMENT-GUIDED.
 *
 * A card the intake classifier caught as `BANTER_NO_ACTION` (see `webPropertyChange.ts`'s
 * `autoResolveNoAction`) also gets one reply from the sender's OWN chief of staff — Walker for
 * Scooter, Wren for Sequoia, read via `chiefOfStaffFor` — in their established voice, alongside
 * the resolution, before the card goes terminal.
 *
 * IN ITS OWN FILE, DELIBERATELY. `sendPartnerEmail` sent directly (never through `sendOrPreview`)
 * is `scripts/validate/every-employee-takes-the-lane.mjs`'s DIRECT_SEND_REGISTER exception, and
 * that registry is keyed BY FILE. `webPropertyChange.ts` otherwise sends every one of its emails
 * (RECEIVED, PLAN, PREVIEW, QUESTION, STUCK, DONE) through `sendOrPreview`, which is what makes
 * "Show me first?" mean the same thing on every one of those. Exempting that whole file for the
 * sake of ONE deliberately-bypassing call would blind the validator to a real regression anywhere
 * else in it; a dedicated file keeps the exemption exactly as narrow as the decision that grants
 * it. See DIRECT_SEND_REGISTER's entry for this file for the reason itself.
 *
 * WHY THE PREVIEW GATE IS SKIPPED HERE ONLY: her decision — banter carries no real content or
 * commitment, so requiring her to approve every joke-reply would defeat the point (it is meant to
 * feel like an actual back-and-forth, not another approval-queue item). Every other email this
 * system sends — real work, a plain question — keeps going through the normal preview-first gate
 * exactly as before; this exception is narrow, banter-only, and lives only here.
 *
 * PACING IS JUDGEMENT-GUIDED, NOT A HARDCODED COUNTER (Addendum 11.1). Her pushback on the first
 * draft — a numeric streak, a fixed redirect line on message #2, silence on #3+ — "trying to
 * codify responses and intake is silly — just be intelligent and respond accordingly." So this
 * file never enforces a threshold; `recentBanterContext` hands the model a plain sentence about
 * the sender's recent history and `INTAKE_JUDGMENT_STANDARD` (same pattern as `VETERAN_STANDARD`
 * in aiEmployeePersonas.ts) guides its own decision whether replying again still makes sense.
 */

/**
 * CONTEXT FOR THE MODEL'S OWN JUDGEMENT, NOT A HARD COUNTER. `card.id` is excluded because this
 * runs BEFORE `auto_resolution` is written for the card being classified right now — it has not
 * yet joined its own history. Still a deterministic, testable fact: how many of this sender's
 * recent cards were banter in a row is a plain database read, and "a real item resets it" is
 * exactly what stopping at the first non-banter card means.
 */
export async function recentBanterContext(env: Env, input: { firmScope: string; senderEmail: string; excludeCardId: string }): Promise<string> {
  const rows =
    (
      await env.WP_OS_DB.prepare(
        `SELECT auto_resolution FROM work_card
          WHERE kind = ?1 AND firm_scope = ?2 AND lower(requested_by_email) = ?3 AND id <> ?4
          ORDER BY created_at DESC LIMIT 5`,
      )
        .bind(WEB_PROPERTY_CHANGE_KIND, input.firmScope, input.senderEmail.trim().toLowerCase(), input.excludeCardId)
        .all<{ auto_resolution: string | null }>()
    ).results ?? [];
  if (rows.length === 0) return "This is the first message on record from this sender — no history to weigh.";
  let consecutive = 0;
  for (const r of rows) {
    if (r.auto_resolution !== "NO_ACTION_NEEDED") break;
    consecutive += 1;
  }
  if (consecutive === 0) return "The message right before this one from this sender was real work or a real question, not banter — a clean slate.";
  return `The ${consecutive} message${consecutive === 1 ? "" : "s"} right before this one from this sender, in a row, were also just banter with nothing to do.`;
}

export type BanterReplyGenerator = (
  env: Env,
  input: { employeeName: string; voice: string; sarcastic: boolean; senderMessage: string; recentContext: string },
) => Promise<{ shouldReply: boolean; line: string | null; aiRunId: string | null }>;

/**
 * THE DEFAULT REPLY GENERATOR — one short model call. Prepends `INTAKE_JUDGMENT_STANDARD` (the
 * shared guidance, not a rulebook) and the persona's own `voice` field used VERBATIM (her
 * instruction: "don't invent new personality text"). The model decides BOTH whether to reply at
 * all and, if so, what to say — `recentContext` is the only signal about pacing it gets; nothing
 * in this function enforces a count. Wren's sarcasm exception is scoped to exactly this prompt
 * string and nothing else Wren does — her `voice` in aiEmployeePersonas.ts is untouched, so the
 * daily brief and the Wednesday cadence read exactly as they always have.
 */
export const defaultGenerateBanterReply: BanterReplyGenerator = async (env, input) => {
  const actor: Actor = { type: "AI", aiEmployeeId: seatId(input.employeeName), roles: [], firmScopes: ["west-peek"] };
  const { run } = await runAi(env, {
    purpose: `${input.employeeName} decides whether to banter back with the partner who wrote in`,
    actor,
    inputs: [
      `${INTAKE_JUDGMENT_STANDARD}\n\n` +
        `You are ${input.employeeName}. Your established voice: "${input.voice}"\n` +
        (input.sarcastic
          ? "SCOPED EXCEPTION, THIS REPLY ONLY: she asked you to be a little sarcastic/mean when you " +
            "banter back with her specifically — she's sarcastic herself and wants it in kind. This " +
            "does not change how you write anything else.\n"
          : "") +
        `A partner wrote something that is pure banter, not a request — nothing to do. RECENT ` +
        `HISTORY WITH THIS SENDER: ${input.recentContext}\n\n` +
        `Decide, in your own judgement, whether replying again still makes sense or whether the ` +
        `better read is to let this one go quiet. If you reply, ONE short line, in your voice, the ` +
        `way a real colleague would banter back — no labels, no TL;DR, just the line.\n\n` +
        `WHAT THEY WROTE:\n"""\n${input.senderMessage.slice(0, 1000)}\n"""\n\n` +
        "Answer in exactly this format and nothing else:\n" +
        "REPLY: yes|no\n" +
        "LINE: <your one-line reply — omit or leave blank if REPLY is no>",
    ],
    sensitivity: "INTERNAL" as never,
    // JUDGEMENT, NOT MECHANICAL (found unclassified by `validate:call-classification`, 22 Sep
    // 2026, and fixed here rather than left — Rule 0). This call decides whether a partner hears
    // from the firm at all right now and, if so, writes the actual line they read; that is exactly
    // "writes or decides something a human reads", never the cheapest-model default under CHEAPO.
    budgetContext: { judgement: true, expectedOutputTokens: 60 },
    routing: { category: "OPERATIONS", taskClass: "banter-reply" },
  });
  if (run.status !== "COMPLETED" || !run.output_text) return { shouldReply: false, line: null, aiRunId: run.id };
  const replyMatch = /REPLY:\s*(yes|no)/i.exec(run.output_text);
  const lineMatch = /LINE:\s*(.+)/i.exec(run.output_text);
  // Unparseable is read as "let it go quiet" — a skipped reply costs nothing; a malformed one sent
  // anyway would be the worse failure.
  if (!replyMatch || replyMatch[1]!.toLowerCase() !== "yes") return { shouldReply: false, line: null, aiRunId: run.id };
  const line = (lineMatch?.[1] ?? "").trim().slice(0, 300);
  if (!line) return { shouldReply: false, line: null, aiRunId: run.id };
  return { shouldReply: true, line, aiRunId: run.id };
};

/**
 * THE REPLY, IF ANY — the model's own call, informed by `recentBanterContext`, never a hardcoded
 * counter. Sends THROUGH `sendPartnerEmail` DIRECTLY, never `sendOrPreview` — see the file header
 * for why that is this file's whole reason to exist separately. Every other gate `sendPartnerEmail`
 * enforces — the roster-resolved sender, the destination whitelist, the format lint, Reply-To, one
 * event per attempt — still runs unchanged.
 */
export async function replyToBanter(
  env: Env,
  card: WebPropertyChangeCard,
  senderMessage: string,
  generate: BanterReplyGenerator = defaultGenerateBanterReply,
): Promise<void> {
  const to = (card.requested_by_email ?? "").trim().toLowerCase();
  const requester = to ? partnerByEmail(to) : null;
  if (!requester) return; // No authenticated partner to reply to — nothing this path can address.

  const employeeName = chiefOfStaffFor(requester.fullName);
  const recentContext = await recentBanterContext(env, { firmScope: card.firm_scope, senderEmail: to, excludeCardId: card.id });
  const voice = EMPLOYEE_PERSONAS.find((p) => p.name === employeeName)?.voice ?? "";
  const sarcastic = employeeName === "Wren"; // Scoped exactly here — her core voice elsewhere is untouched.
  const decision = await generate(env, { employeeName, voice, sarcastic, senderMessage, recentContext });

  if (!decision.shouldReply || !decision.line) {
    await appendEvent(env, {
      eventType: "work_card.banter_reply_skipped",
      actorType: "ai_employee",
      actorId: seatId(employeeName),
      objectType: "work_card",
      objectId: card.id,
      firmScope: card.firm_scope,
      payload: { recent_context: recentContext, ai_run_id: decision.aiRunId },
    });
    return;
  }

  const asked = card.title.replace(/^From [^:]+@[^:]+:\s*/i, "").trim() || card.title;
  const out = await sendPartnerEmail(env, {
    to,
    email: {
      employee: employeeName,
      what: asked.slice(0, 60),
      tldr: decision.line,
      sections: [
        { label: "What you wrote", bullets: [`"${senderMessage.replace(/\s+/g, " ").trim().slice(0, 200)}"`] },
        { label: "Where things stand", bullets: ["Nothing needed on this one — carrying on with the rest of the desk."] },
      ],
    },
    objectType: "work_card",
    objectId: card.id,
    firmScope: card.firm_scope,
    actorId: seatId(employeeName),
    cardKind: WEB_PROPERTY_CHANGE_KIND,
    events: { sent: "work_card.banter_reply_sent", notSent: "work_card.banter_reply_not_sent" },
  });
  await appendEvent(env, {
    eventType: out.sent ? "work_card.banter_reply_sent_detail" : "work_card.banter_reply_failed",
    actorType: "ai_employee",
    actorId: seatId(employeeName),
    objectType: "work_card",
    objectId: card.id,
    firmScope: card.firm_scope,
    payload: { recent_context: recentContext, employee: employeeName, ai_run_id: decision.aiRunId, reason: out.reason },
  });
}
