import { z } from "zod";
import type { Env } from "../env";
import type { RouteContext } from "../router";
import { json } from "../router";
import { appendEvent } from "../events";
import { actorFromIdentity, authorize } from "./authorize";
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
 *
 * ── THE GLOBAL DIAL, AND WHY A ROW MEANS "OVERRIDE" (Addendum 8, 0228) ────────────────────────
 *
 * "Show me the finished email before it goes" was built as a WEB_PROPERTY_CHANGE setting and her
 * real reason for wanting it is not about Porter — it is "I am still early days with these agents
 * and I want to tail them." `email_preview_preference` is the firm-wide default every kind starts
 * from. A kind's OWN `work_kind_rule` row for `done_reply_preview_first` — which today exists only
 * for WEB_PROPERTY_CHANGE, seeded ON by 0223 — is an explicit override and always wins, in EITHER
 * direction: `handleSetWorkKindRule` refuses to write a rule that has no seeded row (404), so the
 * only way a kind acquires one is deliberate. A kind with no row has never been given its own
 * answer and inherits the dial.
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
  const hasOwnRule = Object.prototype.hasOwnProperty.call(rules, DONE_REPLY_PREVIEW_FIRST);
  const effectiveOn = hasOwnRule ? isOn(rules[DONE_REPLY_PREVIEW_FIRST]) : await previewAllPartnerEmailsIsOn(env);
  if (!effectiveOn) return base;
  return {
    cardAsked: true,
    // Whoever ticked the box still owns their own preview; otherwise it is hers, because the rule is.
    tickedByFirmUserId: card.preview_owner_id ?? PREVIEW_PARTNER.firmUserId,
    becauseOfRule: cardAsked !== true,
  };
}

// ── THE FIRM-WIDE TRUST DIAL (0228, Addendum 8) ──────────────────────────────────────────────

export interface EmailPreviewPreferenceRow {
  id: string;
  version_no: number;
  preview_all_partner_emails: number;
  set_by: string;
  firm_scope: string;
  created_at: string;
}

/** The latest version, or null when nobody has ever set it — which means ON (her 22 Sep decision). */
export async function latestEmailPreviewPreference(env: Env, firmScope = "west-peek"): Promise<EmailPreviewPreferenceRow | null> {
  return env.WP_OS_DB.prepare(
    "SELECT * FROM email_preview_preference WHERE firm_scope = ?1 ORDER BY version_no DESC LIMIT 1",
  )
    .bind(firmScope)
    .first<EmailPreviewPreferenceRow>();
}

/** ON with zero rows: a firm that has never touched the dial is a firm still tailing its employees. */
export async function previewAllPartnerEmailsIsOn(env: Env, firmScope = "west-peek"): Promise<boolean> {
  const row = await latestEmailPreviewPreference(env, firmScope);
  return row ? row.preview_all_partner_emails === 1 : true;
}

const setEmailPreviewPreferenceSchema = z.object({ preview_all_partner_emails: z.boolean() });

/** GET /api/email-preview-preference — the dial, read for the settings surface. */
export async function handleGetEmailPreviewPreference(ctx: RouteContext): Promise<Response> {
  const firmScope = actorFromIdentity(ctx.identity!).firmScopes[0] ?? "west-peek";
  const row = await latestEmailPreviewPreference(ctx.env, firmScope);
  return json({
    preview_all_partner_emails: row ? row.preview_all_partner_emails === 1 : true,
    set_by: row?.set_by ?? null,
    set_at: row?.created_at ?? null,
  });
}

/** PATCH /api/email-preview-preference — a Managing Partner moves the dial, firm-wide. */
export async function handleSetEmailPreviewPreference(ctx: RouteContext): Promise<Response> {
  const actor = actorFromIdentity(ctx.identity!);
  if (actor.type !== "HUMAN") {
    return json({ error: "forbidden", detail: "The email preview dial belongs to a Managing Partner." }, { status: 403 });
  }
  const authz = await authorize(ctx.env, actor, "email_preview_preference.set", { objectType: "email_preview_preference", objectId: actor.firmUserId ?? "" });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });

  const body = await ctx.request.json().catch(() => null);
  const parsed = setEmailPreviewPreferenceSchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_input", detail: "Say on or off." }, { status: 400 });

  const firmScope = actor.firmScopes[0] ?? "west-peek";
  const current = await latestEmailPreviewPreference(ctx.env, firmScope);
  const nextVersion = (current?.version_no ?? 0) + 1;
  const id = `epp_${crypto.randomUUID()}`;
  await ctx.env.WP_OS_DB.prepare(
    `INSERT INTO email_preview_preference (id, version_no, preview_all_partner_emails, set_by, firm_scope)
     VALUES (?1, ?2, ?3, ?4, ?5)`,
  )
    .bind(id, nextVersion, parsed.data.preview_all_partner_emails ? 1 : 0, actor.firmUserId ?? ctx.identity!.id, firmScope)
    .run();

  await appendEvent(ctx.env, {
    eventType: "email_preview_preference.set",
    actorType: "firm_user",
    actorId: ctx.identity!.id,
    objectType: "email_preview_preference",
    objectId: id,
    firmScope,
    payload: { version_no: nextVersion, preview_all_partner_emails: parsed.data.preview_all_partner_emails },
  });

  return json({ preview_all_partner_emails: parsed.data.preview_all_partner_emails, set_by: actor.firmUserId ?? ctx.identity!.id, set_at: new Date().toISOString() });
}
