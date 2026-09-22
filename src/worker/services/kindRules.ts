import type { Env } from "../env";
import { PREVIEW_PARTNER } from "../../shared/registry/partners";
import type { NoticeKind } from "./requestReply";

/**
 * THE STANDING RULES OF A CARD KIND, and the one reader of the ones that change behaviour.
 *
 * WHY THIS FILE EXISTS RATHER THAN A SECOND COPY IN EACH SENDER (22 Sep 2026). Two doors can send
 * an employee's finished-work email to the partner who asked for it: `requestReply.replyToRequester`
 * (reached from `workSweep.announceOutcome`, which is where a DONE outcome ends up) and
 * `webPropertyChange.tellRequester` (Porter's own notices). A rule that only one of them remembered
 * is exactly the defect this repo has produced before — `work_card.preview_first` did nothing at all
 * on four of five employees for a week, because the lane was called from one file. So the rule is
 * read HERE, once, and both doors ask.
 *
 * `webPropertyChange.ts` re-exports `rulesFor` and `isOn` from this module so the existing call
 * sites and tests keep their import, and so there is still only one implementation.
 */

export interface KindRule {
  kind: string;
  rule_key: string;
  label: string;
  value: string;
  editable: number;
  note: string;
  set_by: string | null;
  set_at: string;
}

/** The standing rules of a kind, as rows. Seeded by 0219; a Managing Partner edits the editable ones. */
export async function rulesFor(env: Env, kind: string): Promise<Record<string, string>> {
  const rows = (
    await env.WP_OS_DB.prepare("SELECT rule_key, value FROM work_kind_rule WHERE kind = ?1").bind(kind).all<{ rule_key: string; value: string }>()
  ).results ?? [];
  return Object.fromEntries(rows.map((r) => [r.rule_key, r.value]));
}

export function isOn(value: string | undefined): boolean {
  return ["on", "1", "true", "yes"].includes((value ?? "").trim().toLowerCase());
}

/**
 * The rules whose value is a switch, re-exported from the SHARED registry so the Work page and this
 * Worker read the same list. See `src/shared/work/localJobs.ts` for why it lives there.
 */
export { ON_OFF_RULE_KEYS } from "../../shared/work/localJobs";

/** 0223: her rule. The finished-work email is shown to her before it goes. */
export const DONE_REPLY_PREVIEW_FIRST = "done_reply_preview_first";

export interface DoneReplyLane {
  /** What `sendOrPreview` is told the card asked for. */
  cardAsked: boolean | null;
  /** Whose preview it is, when it takes the lane. */
  tickedByFirmUserId: string | null;
  /** One line for the record, when the rule (rather than the card) put it in the lane. */
  becauseOfRule: boolean;
}

/**
 * THE ONE PLACE THE DONE PATH ASKS. Given the card's own tick and the kind, say what the lane is
 * told. The card's own tick is honoured as before; the rule can only ADD a preview, never remove
 * one — the same asymmetry `previewFirstFor` is built on, for the same reason.
 *
 * Only DONE. RECEIVED, PLAN, PREVIEW, QUESTION and STUCK are the back-and-forth of the work; holding
 * one of those would make the partner who asked wait on somebody else to be asked a question.
 */
export async function doneReplyLaneFor(
  env: Env,
  card: { kind?: string | null; preview_first?: number | null; preview_owner_id?: string | null },
  notice: { kind: NoticeKind } | null | undefined,
): Promise<DoneReplyLane> {
  const cardAsked = card.preview_first === 1 ? true : card.preview_first === 0 ? false : null;
  const base: DoneReplyLane = { cardAsked, tickedByFirmUserId: card.preview_owner_id ?? null, becauseOfRule: false };
  if (notice?.kind !== "DONE" || !card.kind) return base;
  const rules = await rulesFor(env, card.kind);
  if (!isOn(rules[DONE_REPLY_PREVIEW_FIRST])) return base;
  return {
    cardAsked: true,
    // Whoever ticked the box still owns their own preview; otherwise it is hers, because the rule is.
    tickedByFirmUserId: card.preview_owner_id ?? PREVIEW_PARTNER.firmUserId,
    becauseOfRule: cardAsked !== true,
  };
}
