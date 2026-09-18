import { z } from "zod";
import type { Env } from "../env";
import type { RouteContext } from "../router";
import { json } from "../router";
import { appendEvent } from "../events";
import { deliver } from "./deliverables";
import { sendPartnerEmail } from "./execEmail";
import { sendViaResend } from "../effects/resendClient";
import { isCloudflareEmailEnabled, sendViaCloudflare } from "../effects/cloudflareEmailClient";
import {
  APPROVED_SEND_ENV_KEY,
  SendBlocked,
  type ApprovedSendMarker,
  type EmailSendResult,
} from "../effects/emailTransport";
import { INTAKE_MAILBOX } from "../../shared/intake/emailTriggers";
import { employeeSenderHeader } from "../../shared/registry/employeeMail";
import { PREVIEW_PARTNER, partnerByFirmUserId } from "../../shared/registry/partners";
import {
  PREVIEW_ACTION_DEFS,
  approvalExpiry,
  hashApprovalToken,
  isPreviewAction,
  mintApprovalToken,
  previewFirstFor,
  previewIntendedFor,
  readApprovalToken,
  type PreviewAction,
  type PreviewLaneReason,
} from "../../shared/work/previewLane";
import { renderExecEmail, type ExecEmailInput } from "../../shared/email/execEmail";

/**
 * "YES, SEND THAT." — the preview lane's database, decision and doors (17 Sep 2026).
 *
 * The contract, her rule and the token's threat model are in `shared/work/previewLane.ts`. This
 * file is the half that needs a database, an identity and a transport.
 *
 * ─── ONE DECISION PATH, TWO DOORS ──────────────────────────────────────────────────────────────
 *
 * She can answer a preview on her Home or from the email on her phone. Those are two ways IN, not
 * two implementations: both call `decidePreview`, exactly as `packetReplyDecision.ts` calls
 * `decidePacket` rather than re-deciding. One status, one event, one send, one trail — and no
 * chance of the phone path and the page path drifting into different rules about the same row.
 *
 * ─── HIS WORDS, NOT A FORWARD ──────────────────────────────────────────────────────────────────
 *
 * The message is composed ONCE, when the work finishes, and stored byte for byte. "Send it" puts
 * those exact bytes on the wire from the employee's own address. Nothing is re-rendered, nothing is
 * re-linted, no header is prepended, no "forwarded by" line is added, and her name appears nowhere
 * on it. `tests/previewLane.test.ts` asserts the transport receives a subject and body identical to
 * what was filed — that assertion is the whole point of the feature and is why the bytes are
 * stored rather than regenerated.
 */

/** Where the buttons in her email point. The same host every other employee email links to. */
const OS_BASE = "https://os.joinwestpeek.com";

export interface PreviewApprovalRow {
  id: string;
  work_card_id: string | null;
  card_kind: string | null;
  employee: string;
  what: string;
  subject: string;
  body_text: string;
  body_html: string | null;
  recipient: string;
  recipient_set_by: "EMPLOYEE" | "PARTNER";
  proposed_recipient: string;
  lane_reason: PreviewLaneReason;
  state: "PENDING" | "SENT" | "RETURNED" | "DISMISSED";
  token_sha256: string;
  expires_at: string;
  used_at: string | null;
  decided_by: string | null;
  decided_at: string | null;
  decided_via: "HOME" | "EMAIL" | null;
  note: string | null;
  send_detail: string | null;
  provider_message_id: string | null;
  deliverable_id: string | null;
  privacy_label: string;
  firm_scope: string;
  created_at: string;
  updated_at: string;
}

// ── FILING ONE ────────────────────────────────────────────────────────────────────────────────

export interface FilePreviewInput {
  /** Roster name of whoever did the work and whose voice the message is in. */
  employee: string;
  /** In words: "Walker's note to the producer he shortlisted". */
  what: string;
  subject: string;
  bodyText: string;
  bodyHtml?: string | null;
  /** The address the employee proposes. She may change it before sending. */
  recipient: string;
  laneReason: PreviewLaneReason;
  workCardId?: string | null;
  cardKind?: string | null;
  firmScope?: string;
}

export interface FiledPreview {
  approval: PreviewApprovalRow;
  /** Emailed to her as well as filed. Says which happened. */
  emailed: boolean;
  emailReason: string;
}

/**
 * File a preview: a row, a copy on her Home, and the email with the three buttons.
 *
 * THE TOKEN IS RETURNED TO NOBODY. It is minted here, hashed into the row, written into the one
 * email that goes to her registered address, and then dropped. There is no API that will hand it
 * back, no field on the row that holds it, and no log line that contains it — which is what makes
 * "the link is the credential" honest rather than decorative.
 */
export async function filePreview(env: Env, input: FilePreviewInput): Promise<FiledPreview> {
  const firmScope = input.firmScope ?? "west-peek";
  const recipient = input.recipient.trim().toLowerCase();
  const id = `pva_${crypto.randomUUID()}`;
  const token = mintApprovalToken();
  const tokenHash = await hashApprovalToken(token);
  const expiresAt = approvalExpiry();

  await env.WP_OS_DB.prepare(
    `INSERT INTO preview_approval
       (id, work_card_id, card_kind, employee, what, subject, body_text, body_html,
        recipient, recipient_set_by, proposed_recipient, lane_reason, state,
        token_sha256, expires_at, firm_scope)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'EMPLOYEE', ?9, ?10, 'PENDING', ?11, ?12, ?13)`,
  )
    .bind(
      id, input.workCardId ?? null, input.cardKind ?? null, input.employee, input.what,
      input.subject, input.bodyText, input.bodyHtml ?? null,
      recipient, input.laneReason, tokenHash, expiresAt, firmScope,
    )
    .run();

  /*
   * ON HER HOME AS WELL AS IN HER INBOX. Operator: "filed on her Home AND emailed". Two surfaces
   * for one thing, deliberately: the inbox is where she is on a Saturday and Home is where she goes
   * on a Monday, and a preview that existed in only one of them is a preview she finds a week late.
   *
   * BEST EFFORT, LIKE EVERY OTHER HANDOVER. If the deliverable cannot be written the approval still
   * exists and the email still carries the buttons; losing the approval because the archive is down
   * would be the wrong trade.
   */
  let deliverableId: string | null = null;
  try {
    const d = await deliver(
      env,
      { type: "SYSTEM", roles: [], firmScopes: [firmScope] },
      {
        kind: "approval_preview",
        title: `${input.employee}: ${input.what} — waiting for your yes`,
        body: previewBodyForHome({ ...input, recipient, expiresAt }),
        preparedBy: input.employee,
        preparedFor: PREVIEW_PARTNER.firmUserId,
        sourceType: "preview_approval",
        sourceId: id,
      },
    );
    deliverableId = d.id;
    await env.WP_OS_DB.prepare("UPDATE preview_approval SET deliverable_id = ?2 WHERE id = ?1")
      .bind(id, d.id)
      .run();
  } catch {
    deliverableId = null;
  }

  const mail = await sendPartnerEmail(env, {
    to: PREVIEW_PARTNER.email,
    email: previewEmailFor({ ...input, recipient, id, token, expiresAt }),
    objectType: "preview_approval",
    objectId: id,
    firmScope,
    actorId: "work_sweep",
    cardKind: input.cardKind ?? null,
    events: { sent: "preview_approval.emailed", notSent: "preview_approval.email_not_sent" },
  });

  await appendEvent(env, {
    eventType: "preview_approval.filed",
    actorType: "system",
    actorId: "work_sweep",
    objectType: "preview_approval",
    objectId: id,
    firmScope,
    payload: {
      employee: input.employee,
      recipient,
      lane_reason: input.laneReason,
      work_card_id: input.workCardId ?? null,
      deliverable_id: deliverableId,
      emailed: mail.sent,
      expires_at: expiresAt,
    },
  });

  const approval = (await env.WP_OS_DB.prepare("SELECT * FROM preview_approval WHERE id = ?1")
    .bind(id)
    .first<PreviewApprovalRow>())!;
  return { approval, emailed: mail.sent, emailReason: mail.reason };
}

/** What her Home copy reads like. The draft in full, under the three answers. */
function previewBodyForHome(input: FilePreviewInput & { recipient: string; expiresAt: string }): string {
  return [
    `**${previewIntendedFor({ recipient: input.recipient, employee: input.employee, setBy: "EMPLOYEE" })}**`,
    "",
    ...PREVIEW_ACTION_DEFS.map((a) => `· **${a.label}** — ${a.effect}`),
    "",
    `Nothing has been sent. It waits until ${new Date(input.expiresAt).toLocaleString("en-GB")}.`,
    "",
    "--- The draft, exactly as it would go out ---",
    "",
    `Subject: ${input.subject}`,
    "",
    input.bodyText,
  ].join("\n");
}

/** The email she can answer from her phone. */
function previewEmailFor(
  input: FilePreviewInput & { recipient: string; id: string; token: string; expiresAt: string },
): ExecEmailInput {
  const link = `${OS_BASE}/api/approve/${input.token}`;
  return {
    employee: input.employee,
    what: `${input.what} — ready to send, waiting on you`,
    tldr: `I have finished this and it is addressed to ${input.recipient}, who is outside the firm, so it has not gone anywhere. Say the word and it goes exactly as written.`,
    sections: [
      {
        label: "Who it is for",
        bullets: [
          `${input.recipient} — ${input.laneReason === "ASKED_FOR" ? "you asked to see this one first" : "outside the firm, so it is preview-first by your rule"}.`,
          "You can change the address before sending it, on Home.",
        ],
      },
      {
        label: "Your call",
        bullets: [
          `**Send it** — it goes to ${input.recipient} now, from me, in my words, unchanged: ${link}`,
          `**Send it back** with a note and I will redo it: ${link}`,
          `**Dismiss it** and it dies there: ${link}`,
          `The link works once and stops working on ${new Date(input.expiresAt).toLocaleString("en-GB")}. It opens a page with the three buttons — a tap on a link never sends anything by itself.`,
        ],
      },
    ],
    details: [
      "The draft, exactly as it would go out:",
      "",
      `Subject: ${input.subject}`,
      "",
      input.bodyText,
    ].join("\n"),
  };
}

// ── THE ONE DOOR AN EMPLOYEE'S FINISHED WORK LEAVES THROUGH ───────────────────────────────────

export interface SendOrPreviewInput {
  to: string;
  email: ExecEmailInput;
  objectType: string;
  objectId: string;
  firmScope: string;
  actorId?: string;
  cardKind?: string | null;
  workCardId?: string | null;
  /** `work_card.preview_first`. NULL is "nobody said" and the default rule decides. */
  cardAsked?: boolean | null;
  events?: { sent: string; notSent: string };
  /** In words, for her Home and the preview email. Defaults to the email's own `what`. */
  what?: string;
}

export interface SendOrPreviewOutcome {
  /** True when it went to the named recipient with nobody's hand in between. */
  sent: boolean;
  /** True when it went into the lane instead. */
  previewed: boolean;
  to: string;
  reason: string;
  subject: string;
  approvalId?: string;
}

/**
 * An employee has finished something addressed to somebody. This decides which of the two things
 * happens, and it is the ONLY place that decision is made.
 *
 * ASKED OF `previewFirstFor`, WHICH ASKS THE REGISTRY. Not a domain test, not a typed address, not
 * a sentence in a prompt. A partner recipient sends normally — which is exactly what keeps Walker's
 * Monday hire search landing in Scooter's inbox on Monday with nothing in between.
 */
export async function sendOrPreview(env: Env, input: SendOrPreviewInput): Promise<SendOrPreviewOutcome> {
  const to = input.to.trim().toLowerCase();
  const lane = previewFirstFor({ recipient: to, cardAsked: input.cardAsked ?? null });

  if (!lane.previewFirst) {
    const out = await sendPartnerEmail(env, {
      to,
      email: input.email,
      objectType: input.objectType,
      objectId: input.objectId,
      firmScope: input.firmScope,
      actorId: input.actorId,
      cardKind: input.cardKind ?? null,
      events: input.events,
    });
    return { sent: out.sent, previewed: false, to, reason: out.reason, subject: out.subject };
  }

  const rendered = renderExecEmail(input.email);
  const filed = await filePreview(env, {
    employee: input.email.employee,
    what: input.what ?? input.email.what,
    subject: rendered.subject,
    bodyText: rendered.text,
    bodyHtml: rendered.html,
    recipient: to,
    laneReason: lane.reason!,
    workCardId: input.workCardId ?? null,
    cardKind: input.cardKind ?? null,
    firmScope: input.firmScope,
  });

  return {
    sent: false,
    previewed: true,
    to,
    subject: rendered.subject,
    approvalId: filed.approval.id,
    reason:
      `${lane.why} It is on ${PREVIEW_PARTNER.firstName}'s Home and ` +
      (filed.emailed ? "in her inbox" : `NOT in her inbox (${filed.emailReason})`) +
      ", with Send it / Send it back / Dismiss.",
  };
}

// ── THE DECISION ──────────────────────────────────────────────────────────────────────────────

export class PreviewApprovalError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "PreviewApprovalError";
  }
}

export interface DecideInput {
  action: PreviewAction;
  /** Who decided. A partner id from an authenticated session, or the token's owner. */
  byFirmUserId: string;
  via: "HOME" | "EMAIL";
  /** Her words when she sends it back. Required for RETURN: a rejection with no reason is a shrug. */
  note?: string | null;
  /**
   * Her override of the address, when she sets one. Operator: "we should be able to put a recipient
   * to send it to right?" The employee proposes; she can change it.
   */
  recipient?: string | null;
}

export interface DecideOutcome {
  approval: PreviewApprovalRow;
  action: PreviewAction;
  sent: boolean;
  detail: string;
}

/**
 * The one decision path. Both doors call this.
 *
 * SINGLE USE IS CLAIMED, NOT CHECKED. The state change is an UPDATE whose WHERE clause requires the
 * row to still be PENDING with `used_at IS NULL`; if it changed nothing, somebody else got there
 * first and this returns the refusal rather than sending a second copy. Reading the row and then
 * writing it would leave a window between the two, and the two things most likely to arrive inside
 * that window are a double tap on a phone and a mail client prefetching a link.
 */
export async function decidePreview(
  env: Env,
  approvalId: string,
  input: DecideInput,
): Promise<DecideOutcome> {
  const row = await env.WP_OS_DB.prepare("SELECT * FROM preview_approval WHERE id = ?1")
    .bind(approvalId)
    .first<PreviewApprovalRow>();
  if (!row) throw new PreviewApprovalError(404, "not_found", "no such preview");
  if (row.state !== "PENDING") {
    throw new PreviewApprovalError(
      409,
      "already_decided",
      `this preview was already ${row.state.toLowerCase()}${row.decided_at ? ` on ${row.decided_at}` : ""}. It cannot be decided twice.`,
    );
  }
  if (Date.parse(row.expires_at) <= Date.now()) {
    throw new PreviewApprovalError(
      410,
      "expired",
      `this preview expired on ${row.expires_at}. Ask ${row.employee} for a fresh one rather than sending a stale draft.`,
    );
  }
  if (input.action === "RETURN" && !(input.note ?? "").trim()) {
    throw new PreviewApprovalError(
      400,
      "note_required",
      "sending it back needs your words — a rejection with no reason tells the employee nothing and the next draft is the same draft",
    );
  }

  const recipient = (input.recipient ?? "").trim().toLowerCase();
  if (recipient && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(recipient)) {
    throw new PreviewApprovalError(400, "invalid_recipient", `"${recipient}" is not an email address`);
  }
  const to = recipient || row.recipient;
  const setBy = recipient && recipient !== row.recipient ? "PARTNER" : row.recipient_set_by;

  const nextState = input.action === "SEND" ? "SENT" : input.action === "RETURN" ? "RETURNED" : "DISMISSED";

  // The claim. Nothing below this line can run twice for one approval.
  const claim = await env.WP_OS_DB.prepare(
    `UPDATE preview_approval
        SET state = ?2, recipient = ?3, recipient_set_by = ?4, note = ?5,
            decided_by = ?6, decided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            decided_via = ?7, used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?1 AND state = 'PENDING' AND used_at IS NULL`,
  )
    .bind(approvalId, nextState, to, setBy, input.note ?? null, input.byFirmUserId, input.via)
    .run();
  if ((claim.meta?.changes ?? 0) === 0) {
    throw new PreviewApprovalError(409, "already_decided", "somebody answered this preview a moment ago");
  }

  let sent = false;
  let detail: string;

  if (input.action === "SEND") {
    const result = await sendApproved(env, { ...row, recipient: to });
    sent = result.sent;
    detail = result.detail;
    await env.WP_OS_DB.prepare(
      "UPDATE preview_approval SET send_detail = ?2, provider_message_id = ?3, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1",
    )
      .bind(approvalId, detail, result.provider_message_id)
      .run();
  } else if (input.action === "RETURN") {
    await returnToEmployee(env, row, input.note!.trim());
    detail = `sent back to ${row.employee} with your note. They redo it and preview it again.`;
  } else {
    detail = "dismissed. Nothing was sent and nobody was told.";
  }

  await appendEvent(env, {
    eventType:
      input.action === "SEND"
        ? sent
          ? "preview_approval.sent"
          : "preview_approval.send_failed"
        : input.action === "RETURN"
          ? "preview_approval.returned"
          : "preview_approval.dismissed",
    actorType: "firm_user",
    actorId: input.byFirmUserId,
    objectType: "preview_approval",
    objectId: approvalId,
    firmScope: row.firm_scope,
    payload: {
      action: input.action,
      via: input.via,
      recipient: to,
      recipient_set_by: setBy,
      employee: row.employee,
      detail,
      // Never the token, and never the body. The row holds both; the spine holds neither.
      subject: row.subject,
    },
  });

  const approval = (await env.WP_OS_DB.prepare("SELECT * FROM preview_approval WHERE id = ?1")
    .bind(approvalId)
    .first<PreviewApprovalRow>())!;
  return { approval, action: input.action, sent, detail };
}

/**
 * Put the employee's bytes on the wire.
 *
 * NOT `sendPartnerEmail`. That door renders an `ExecEmailInput`, lints it, and refuses any address
 * that is not a partner's — all correct for an employee writing to a partner, and all wrong here.
 * This message was composed, linted and approved already; re-rendering it would be a second
 * composition, and a second composition is a second chance to differ from the thing she said yes
 * to. The stored subject and body go out verbatim.
 *
 * THE APPROVAL RIDES ON THE ENV, WHICH IS WHAT THE BOUNDARY CHECKS. `assertPreviewLane` refuses any
 * non-partner recipient without a marker naming that exact address, so this is the only way bytes
 * reach an outsider — and the marker is a shallow copy of the env, never a mutation, so one
 * request's approval cannot leak into another's send in the same isolate.
 */
async function sendApproved(env: Env, row: PreviewApprovalRow): Promise<EmailSendResult> {
  const marker: ApprovedSendMarker = { approvalId: row.id, recipient: row.recipient };
  const approvedEnv = { ...env, [APPROVED_SEND_ENV_KEY]: marker } as Env;
  const payload = {
    to: row.recipient,
    subject: row.subject,
    text: row.body_text,
    ...(row.body_html ? { html: row.body_html } : {}),
    // HIS ADDRESS, NOT HERS AND NOT THE FIRM'S. The recipient replies to the employee who wrote it.
    from: employeeSenderHeader(row.employee),
    replyTo: INTAKE_MAILBOX,
  };
  try {
    return isCloudflareEmailEnabled(env)
      ? await sendViaCloudflare(approvedEnv, payload)
      : await sendViaResend(approvedEnv, payload);
  } catch (err) {
    if (err instanceof SendBlocked) {
      return { sent: false, provider: "resend", provider_message_id: null, detail: err.message };
    }
    return {
      sent: false,
      provider: "resend",
      provider_message_id: null,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Her words reach the employee.
 *
 * A `work_steer` when the work has a KIND, because a weekly duty opens a new card every week and
 * closes it the same day — a note on the row would be a note nothing will read again. See migration
 * 0180 and `execEmail.ts` for the same reasoning about replies. A note on the card as well when
 * there is a card, so the trail is complete in both directions.
 */
async function returnToEmployee(env: Env, row: PreviewApprovalRow, note: string): Promise<void> {
  if (row.card_kind) {
    await env.WP_OS_DB.prepare(
      `INSERT INTO work_steer (id, card_kind, from_card_id, said_by, body, firm_scope)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    )
      .bind(
        `wst_${crypto.randomUUID()}`, row.card_kind, row.work_card_id,
        PREVIEW_PARTNER.firmUserId, note, row.firm_scope,
      )
      .run()
      .catch(() => undefined);
  }
  if (row.work_card_id) {
    await env.WP_OS_DB.prepare(
      `INSERT INTO work_card_note (id, work_card_id, author_id, body, firm_scope)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    )
      .bind(`wcn_${crypto.randomUUID()}`, row.work_card_id, PREVIEW_PARTNER.firmUserId, note, row.firm_scope)
      .run()
      .catch(() => undefined);
  }
}

// ── LOOKING ONE UP BY ITS TOKEN ───────────────────────────────────────────────────────────────

/**
 * The token → row lookup, and the one place a bad token is refused.
 *
 * REFUSES ANYTHING IT CANNOT CONFIDENTLY READ, and records the refusal. A wrong shape never reaches
 * the database; a right shape that matches no row is the same answer as a wrong one, so a prober
 * learns nothing from the difference. Expiry and single use are enforced here too, so a stale link
 * gets a page that explains itself rather than a button that quietly does nothing.
 */
export async function approvalByToken(
  env: Env,
  raw: string | null | undefined,
): Promise<{ row: PreviewApprovalRow | null; refusal: string | null }> {
  const token = readApprovalToken(raw);
  if (!token) {
    await appendEvent(env, {
      eventType: "preview_approval.token_unreadable",
      actorType: "system",
      actorId: "system",
      objectType: "preview_approval",
      objectId: "unknown",
      // Length only. The string itself is a credential attempt and is never written down.
      payload: { length: (raw ?? "").trim().length },
    }).catch(() => undefined);
    return { row: null, refusal: "that link is not one of ours. Nothing was sent." };
  }
  const row = await env.WP_OS_DB.prepare("SELECT * FROM preview_approval WHERE token_sha256 = ?1")
    .bind(await hashApprovalToken(token))
    .first<PreviewApprovalRow>();
  if (!row) return { row: null, refusal: "that link is not one of ours. Nothing was sent." };
  if (row.state !== "PENDING" || row.used_at) {
    return { row, refusal: `this one was already ${row.state.toLowerCase()}. A link works once.` };
  }
  if (Date.parse(row.expires_at) <= Date.now()) {
    return { row, refusal: `this link expired on ${row.expires_at}. Ask ${row.employee} for a fresh draft.` };
  }
  return { row, refusal: null };
}

// ── ROUTES ────────────────────────────────────────────────────────────────────────────────────

const decideSchema = z.object({
  action: z.string().trim().min(1),
  note: z.string().trim().max(4000).optional(),
  recipient: z.string().trim().max(200).optional(),
});

/** GET /api/preview-approvals — what is waiting for her. Authenticated; partners only. */
export async function handleListPreviewApprovals(ctx: RouteContext): Promise<Response> {
  if (!partnerByFirmUserId(ctx.identity!.id)) {
    return json({ error: "forbidden", reason: "previews are answered by a Managing Partner" }, { status: 403 });
  }
  const rows = await ctx.env.WP_OS_DB.prepare(
    `SELECT id, work_card_id, card_kind, employee, what, subject, body_text, recipient,
            recipient_set_by, proposed_recipient, lane_reason, state, expires_at, decided_at,
            decided_via, note, send_detail, deliverable_id, created_at
       FROM preview_approval
      WHERE firm_scope = ?1 AND state = 'PENDING' AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
      ORDER BY created_at DESC`,
  )
    .bind("west-peek")
    .all();
  const previews = (rows.results ?? []) as Array<Record<string, unknown>>;
  return json({
    previews: previews.map((p) => ({
      ...p,
      intended_for: previewIntendedFor({
        recipient: String(p.recipient),
        employee: String(p.employee),
        setBy: p.recipient_set_by === "PARTNER" ? "PARTNER" : "EMPLOYEE",
      }),
    })),
    actions: PREVIEW_ACTION_DEFS,
  });
}

/**
 * POST /api/preview-approvals/:id/decide — the Home door.
 *
 * AUTHENTICATED, AND A PARTNER. An approval is the firm speaking; the browser identity that can
 * read every page is explicitly not allowed to authorise one.
 */
export async function handleDecidePreviewApproval(ctx: RouteContext): Promise<Response> {
  if (!partnerByFirmUserId(ctx.identity!.id)) {
    return json({ error: "forbidden", reason: "only a Managing Partner can approve a send" }, { status: 403 });
  }
  const parsed = decideSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  if (!isPreviewAction(parsed.data.action)) {
    return json({ error: "invalid_input", detail: `unknown action '${parsed.data.action}'` }, { status: 400 });
  }
  try {
    const out = await decidePreview(ctx.env, ctx.params.id!, {
      action: parsed.data.action,
      byFirmUserId: ctx.identity!.id,
      via: "HOME",
      note: parsed.data.note ?? null,
      recipient: parsed.data.recipient ?? null,
    });
    return json(out);
  } catch (err) {
    if (err instanceof PreviewApprovalError) {
      return json({ error: err.code, detail: err.message }, { status: err.status });
    }
    throw err;
  }
}

/**
 * GET /api/approve/:token — the page her email opens.
 *
 * UNAUTHENTICATED BY DESIGN, AND A GET THAT CHANGES NOTHING. The token is the credential; see the
 * threat model in `shared/work/previewLane.ts`. This renders the draft and three buttons that POST
 * back, because a GET that sent mail would be sent by the first mail client, link scanner or
 * corporate proxy that decided to prefetch the URL — and that is not a theoretical actor, it is
 * standard behaviour in several of them. One tap on a phone either way; nothing moves on the tap
 * that opened the page.
 */
export async function handleOpenPreviewApproval(ctx: RouteContext): Promise<Response> {
  const { row, refusal } = await approvalByToken(ctx.env, ctx.params.token!);
  const token = readApprovalToken(ctx.params.token!) ?? "";
  if (!row || refusal) {
    return htmlPage(
      "Nothing to do",
      `<h1>Nothing to do</h1><p>${escapeHtml(refusal ?? "that link is not one of ours.")}</p>
       <p>Nothing has been sent. Open the OS to see what is waiting.</p>`,
      refusal && row ? 409 : 404,
    );
  }
  const intended = previewIntendedFor({
    recipient: row.recipient,
    employee: row.employee,
    setBy: row.recipient_set_by,
  });
  const post = `/api/approve/${encodeURIComponent(token)}/decide`;
  return htmlPage(
    `${row.employee}: ${row.what}`,
    `<h1>${escapeHtml(row.employee)} — ${escapeHtml(row.what)}</h1>
     <p class="lede">${escapeHtml(intended)}</p>
     <form method="post" action="${post}">
       <label for="recipient">Send it to</label>
       <input id="recipient" name="recipient" type="email" value="${escapeHtml(row.recipient)}" />
       <button name="action" value="SEND" class="go">Send it</button>
       <label for="note">If you are sending it back, say why</label>
       <textarea id="note" name="note" rows="3" placeholder="What should ${escapeHtml(row.employee)} change?"></textarea>
       <button name="action" value="RETURN">Send it back</button>
       <button name="action" value="DISMISS" class="quiet">Dismiss</button>
     </form>
     <h2>The draft, exactly as it would go out</h2>
     <p class="subject"><strong>Subject:</strong> ${escapeHtml(row.subject)}</p>
     <pre>${escapeHtml(row.body_text)}</pre>`,
  );
}

/**
 * POST /api/approve/:token/decide — the phone door.
 *
 * Takes a form post, because this page is served to a mail client's browser with no script. It
 * calls `decidePreview`, the same function the Home button calls: one decision path, one status,
 * one event, one send.
 */
export async function handleDecidePreviewApprovalByToken(ctx: RouteContext): Promise<Response> {
  const { row, refusal } = await approvalByToken(ctx.env, ctx.params.token!);
  if (!row || refusal) {
    return htmlPage(
      "Nothing to do",
      `<h1>Nothing to do</h1><p>${escapeHtml(refusal ?? "that link is not one of ours.")}</p>`,
      refusal && row ? 409 : 404,
    );
  }
  const form = await ctx.request.formData().catch(() => null);
  const action = String(form?.get("action") ?? "");
  if (!isPreviewAction(action)) {
    return htmlPage("Nothing to do", "<h1>Nothing to do</h1><p>That was not one of the three answers, so nothing happened.</p>", 400);
  }
  try {
    const out = await decidePreview(ctx.env, row.id, {
      action,
      // The token authorises on her behalf; it was minted for, and mailed to, her address alone.
      byFirmUserId: PREVIEW_PARTNER.firmUserId,
      via: "EMAIL",
      note: String(form?.get("note") ?? "") || null,
      recipient: String(form?.get("recipient") ?? "") || null,
    });
    return htmlPage(
      out.action === "SEND" ? (out.sent ? "Sent" : "Not sent") : out.action === "RETURN" ? "Sent back" : "Dismissed",
      `<h1>${out.action === "SEND" ? (out.sent ? "Sent" : "Not sent") : out.action === "RETURN" ? "Sent back" : "Dismissed"}</h1>
       <p>${escapeHtml(out.detail)}</p>
       <p class="quiet">This link has now been used and will not work again.</p>`,
    );
  } catch (err) {
    if (err instanceof PreviewApprovalError) {
      return htmlPage("Nothing to do", `<h1>Nothing to do</h1><p>${escapeHtml(err.message)}</p>`, err.status);
    }
    throw err;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * A page a phone can read with no stylesheet fetch and no script.
 *
 * `noindex` and `no-store`: this page holds an unsent draft and is reachable without a session, so
 * it must not be cached by anything between here and the tab, and must never be indexed.
 */
function htmlPage(title: string, body: string, status = 200): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8" />
     <meta name="viewport" content="width=device-width,initial-scale=1" />
     <meta name="robots" content="noindex,nofollow" />
     <title>${escapeHtml(title)} · West Peek</title>
     <style>
       :root { color-scheme: light dark; }
       body { font: 16px/1.55 system-ui, sans-serif; margin: 0; padding: 24px; max-width: 42rem; }
       h1 { font-size: 1.35rem; margin: 0 0 12px; }
       h2 { font-size: 1rem; margin: 28px 0 8px; }
       .lede { font-weight: 600; }
       label { display: block; margin: 16px 0 4px; font-size: 0.9rem; }
       input, textarea { width: 100%; box-sizing: border-box; padding: 10px; font: inherit; }
       button { display: block; width: 100%; margin: 10px 0; padding: 14px; font: inherit; cursor: pointer; }
       button.go { font-weight: 700; }
       button.quiet, .quiet { opacity: 0.75; }
       pre { white-space: pre-wrap; word-wrap: break-word; padding: 12px; border: 1px solid; }
     </style></head><body>${body}</body></html>`,
    {
      status,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    },
  );
}
