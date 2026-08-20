import { z } from "zod";
import type { Env } from "../env";
import type { RouteContext } from "../router";
import { json } from "../router";
import { appendEvent } from "../events";
import { recordSwallowed } from "./swallowed";
import { actorFromIdentity, authorize, privacyVisibilityClause, type Actor } from "./authorize";
import { uploadDocument } from "./documents";
import {
  type DeliverableForExport,
  exportFilename,
  kindDef,
  renderMarkdown,
} from "../../shared/deliverables/deliverable";
import { isCloudflareEmailEnabled, sendViaCloudflare } from "../effects/cloudflareEmailClient";
import { isEmailSendEnabled, sendViaResend } from "../effects/resendClient";

/**
 * Delivering things, and letting people keep them.
 *
 * ONE ROAD FOR FOUR ARTIFACTS. See `shared/deliverables/deliverable.ts` for why this is a concept
 * rather than a pair of buttons on Research.
 *
 * FILED THE MOMENT IT IS DELIVERED, not when it ages out of a page. The operator's instinct was
 * recent ones on Research and historical ones in Documents; making it MOVE would create a window
 * where it is in neither and a question — "where is it now" — the system can answer wrongly. So it
 * becomes a document immediately, Research shows the most recent few as a convenience view, and
 * nothing migrates.
 */

export interface DeliverableRow {
  id: string;
  kind: string;
  title: string;
  body: string;
  prepared_by: string;
  prepared_for: string;
  source_type: string | null;
  source_id: string | null;
  document_id: string | null;
  privacy_label: string;
  firm_scope: string;
  created_at: string;
}

export interface DeliverInput {
  kind: string;
  title: string;
  body: string;
  /** Roster name of whoever signs it. */
  preparedBy: string;
  /** firm_user id of whoever asked. Puts it on their Home page. */
  preparedFor: string;
  sourceType?: string | null;
  sourceId?: string | null;
  privacyLabel?: string;
}

/**
 * Hand something over: record it, file it, and return it.
 *
 * FILING IS BEST-EFFORT AND VISIBLE. If R2 is unavailable the deliverable is still recorded and
 * still readable — losing the handover because the archive is down would be the wrong trade — but
 * `document_id` stays null and the interface says the filed copy is missing rather than pretending
 * it exists.
 */
export async function deliver(env: Env, actor: Actor, input: DeliverInput): Promise<DeliverableRow> {
  const firmScope = actor.firmScopes[0] ?? "west-peek";
  const id = `dlv_${crypto.randomUUID()}`;
  const privacy = input.privacyLabel ?? "INTERNAL";

  /*
   * Re-delivering the same source updates rather than stacking duplicates on a Home page.
   *
   * THE `WHERE` IS LOAD-BEARING AND WAS MISSING. The unique index on (source_type, source_id) is
   * PARTIAL — it only covers rows where both are non-null — and SQLite requires a conflict target
   * to match a real index including its predicate. Without the WHERE repeated here, every call
   * failed with "ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint".
   *
   * It failed SILENTLY, which is the worse half: both callers wrap `deliver()` in a try/catch so
   * that a handover failure cannot fail the brief or the research packet it belongs to. So the
   * whole deliverables road would have thrown on every single call and reported nothing, and the
   * first thing to exercise it would have been an unattended cron job at six in the morning.
   * Typecheck, 1,154 tests and four validators all passed with this in place; it was found by
   * running the statement against the real schema.
   */
  await env.WP_OS_DB.prepare(
    `INSERT INTO deliverable (id, kind, title, body, prepared_by, prepared_for, source_type, source_id, privacy_label, firm_scope)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
     ON CONFLICT (source_type, source_id) WHERE source_type IS NOT NULL AND source_id IS NOT NULL
     DO UPDATE SET
       title = excluded.title, body = excluded.body, prepared_by = excluded.prepared_by,
       created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  )
    .bind(
      id, input.kind, input.title, input.body, input.preparedBy, input.preparedFor,
      input.sourceType ?? null, input.sourceId ?? null, privacy, firmScope,
    )
    .run();

  const row = (await env.WP_OS_DB.prepare(
    input.sourceType && input.sourceId
      ? "SELECT * FROM deliverable WHERE source_type = ?1 AND source_id = ?2"
      : "SELECT * FROM deliverable WHERE id = ?1",
  )
    .bind(...(input.sourceType && input.sourceId ? [input.sourceType, input.sourceId] : [id]))
    .first<DeliverableRow>())!;

  if (!row.document_id) {
    try {
      const markdown = renderMarkdown(toExport(row, input.preparedFor));
      const { document } = await uploadDocument(env, actor, {
        title: row.title,
        doc_type: kindDef(row.kind)?.docType ?? "BRIEF",
        privacy_label: privacy,
        content_type: "text/markdown",
        content_base64: base64(markdown),
      });
      await env.WP_OS_DB.prepare("UPDATE deliverable SET document_id = ?2 WHERE id = ?1")
        .bind(row.id, document.id)
        .run();
      row.document_id = document.id;
    } catch (err) {
      // Filing failed. The handover stands and the interface reports the missing archive
      // copy — but it also goes in the ledger, because a filing path that has quietly stopped
      // working is otherwise only discoverable by noticing the documents table is empty.
      await recordSwallowed(env, "deliverables.file", err, { deliverable_id: row.id, kind: row.kind });
    }
  }

  await appendEvent(env, {
    eventType: "deliverable.delivered",
    actorType: actor.type === "HUMAN" ? "firm_user" : "ai_employee",
    actorId: actor.firmUserId ?? input.preparedBy,
    objectType: "deliverable",
    objectId: row.id,
    firmScope,
    payload: { kind: row.kind, prepared_by: row.prepared_by, prepared_for: row.prepared_for, filed: Boolean(row.document_id) },
  });

  return row;
}

function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function toExport(row: DeliverableRow, forName: string): DeliverableForExport {
  return {
    kind: row.kind,
    title: row.title,
    body: row.body,
    preparedBy: row.prepared_by,
    preparedFor: forName,
    preparedAt: row.created_at,
  };
}

/** GET /api/deliverables — what has been handed to you, newest first. */
export async function handleListDeliverables(ctx: RouteContext): Promise<Response> {
  const url = new URL(ctx.request.url);
  const kind = url.searchParams.get("kind");
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 20), 100);
  const visibility = privacyVisibilityClause(ctx.identity!, "privacy_label");

  // BOTH PARTNERS SEE EACH OTHER'S. Research is INTERNAL by default, and the operator's question was
  // explicitly "if scooter requests research i can find it". Anything labelled more sensitive is
  // filtered by the visibility clause, which is where that decision belongs.
  const rows = kind
    ? await ctx.env.WP_OS_DB.prepare(
        `SELECT * FROM deliverable WHERE kind = ?1 AND ${visibility} ORDER BY created_at DESC LIMIT ?2`,
      ).bind(kind, limit).all<DeliverableRow>()
    : await ctx.env.WP_OS_DB.prepare(
        `SELECT * FROM deliverable WHERE ${visibility} ORDER BY created_at DESC LIMIT ?1`,
      ).bind(limit).all<DeliverableRow>();

  return json({ deliverables: rows.results ?? [] });
}

async function loadVisible(ctx: RouteContext, id: string): Promise<DeliverableRow | null> {
  const visibility = privacyVisibilityClause(ctx.identity!, "privacy_label");
  return await ctx.env.WP_OS_DB.prepare(`SELECT * FROM deliverable WHERE id = ?1 AND ${visibility}`)
    .bind(id)
    .first<DeliverableRow>();
}

async function nameOf(env: Env, firmUserId: string): Promise<string> {
  const row = await env.WP_OS_DB.prepare("SELECT full_name FROM firm_user WHERE id = ?1")
    .bind(firmUserId)
    .first<{ full_name: string }>();
  return row?.full_name ?? "the firm";
}

/** GET /api/deliverables/:id/download — the file itself. */
export async function handleDownloadDeliverable(ctx: RouteContext): Promise<Response> {
  const row = await loadVisible(ctx, ctx.params.id!);
  if (!row) return json({ error: "not_found" }, { status: 404 });

  const forExport = toExport(row, await nameOf(ctx.env, row.prepared_for));
  const markdown = renderMarkdown(forExport);
  return new Response(markdown, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="${exportFilename(forExport)}"`,
      // A deliverable is firm-internal and must not be cached by anything between here and the tab.
      "cache-control": "no-store",
    },
  });
}

const emailSchema = z.object({
  /** Omitted means "to me". A firm user id, never a typed address — see below. */
  to_firm_user_id: z.string().trim().max(120).optional(),
});

/**
 * POST /api/deliverables/:id/email — send it to a partner's own inbox.
 *
 * WHY THIS DOES NOT RAISE AN APPROVAL, which is the one genuinely awkward decision here.
 *
 * `effect.email.send` is an external effect and gates every send behind an approval card. Its own
 * registry description says it is for delivering "to an outside recipient", and that is exactly the
 * right gate for what it was written for: information leaving the firm.
 *
 * A partner emailing themselves a deliverable they are already reading on screen has not moved
 * anything across that boundary. The recipient is inside it, the content was already visible to
 * them, and requiring a countersignature from their own partner to put a copy in their own inbox
 * would be ceremony that teaches people to route around the gate.
 *
 * SO THE NARROWNESS IS THE WHOLE SAFETY ARGUMENT, and it is enforced rather than described:
 * the recipient MUST resolve to a `firm_user` row. There is no free-text address parameter, so
 * there is no version of this that can reach outside the firm. A typed address is an external send
 * and goes through the ordinary approval path like everything else.
 *
 * It is still recorded, because "who sent what to whom" stays answerable either way.
 */
export async function handleEmailDeliverable(ctx: RouteContext): Promise<Response> {
  const row = await loadVisible(ctx, ctx.params.id!);
  if (!row) return json({ error: "not_found" }, { status: 404 });

  const parsed = emailSchema.safeParse(await ctx.request.json().catch(() => ({})));
  if (!parsed.success) return json({ error: "invalid_input" }, { status: 400 });

  const actor = actorFromIdentity(ctx.identity!);
  const authz = await authorize(ctx.env, actor, "deliverable.email_self", {
    objectType: "deliverable",
    objectId: row.id,
    firmScope: row.firm_scope,
  });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });

  const recipientId = parsed.data.to_firm_user_id ?? ctx.identity!.id;
  // THE GATE. A recipient who is not a firm user cannot be reached from here at all.
  const recipient = await ctx.env.WP_OS_DB.prepare("SELECT id, full_name, email FROM firm_user WHERE id = ?1")
    .bind(recipientId)
    .first<{ id: string; full_name: string; email: string | null }>();
  if (!recipient?.email) {
    return json(
      { error: "not_a_firm_recipient", detail: "This route only sends to a partner's registered address. Anything else is an external send and needs an approval." },
      { status: 400 },
    );
  }

  const markdown = renderMarkdown(toExport(row, recipient.full_name));
  const message = {
    to: recipient.email,
    subject: `${kindDef(row.kind)?.label ?? "Deliverable"}: ${row.title}`,
    text: markdown,
    from: ctx.env.WP_OS_EMAIL_FROM,
  };

  const result = isCloudflareEmailEnabled(ctx.env)
    ? await sendViaCloudflare(ctx.env, message)
    : isEmailSendEnabled(ctx.env)
      ? await sendViaResend(ctx.env, message)
      : { sent: false, provider: "resend" as const, detail: "Email sending is switched off, so nothing was sent." };

  await appendEvent(ctx.env, {
    eventType: "deliverable.emailed",
    actorType: "firm_user",
    actorId: ctx.identity!.id,
    objectType: "deliverable",
    objectId: row.id,
    firmScope: row.firm_scope,
    payload: { to: recipient.id, sent: result.sent, provider: result.provider },
  });

  return json({ sent: result.sent, detail: result.detail, to: recipient.full_name });
}
