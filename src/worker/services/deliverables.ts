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
  archivedDeliverableKinds,
  exportFilename,
  kindDef,
  renderMarkdown,
} from "../../shared/deliverables/deliverable";
import { sendFirmUserCopy } from "./execEmail";
import { isBulletOrLabel, type ExecEmailInput } from "../../shared/email/execEmail";

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
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  dismissed_at: string | null;
  dismissed_by: string | null;
  /** When "Put it back" last rescued it from the put-away list; the week counts from here. */
  restored_at?: string | null;
}

/**
 * A WEEK PUTS THINGS AWAY.
 *
 * Operator, 15 Sep 2026: research packets, weekly reviews and Room packets that nobody read piled
 * up on Home for weeks. Anything that is not a morning brief (those are superseded by the next
 * one, below), is older than seven days, and was never marked as read or put away, is PUT AWAY BY
 * AGE. Derived in the query, like the brief rule: nothing is written, nothing claims she decided.
 * It sits on the put-away list beside what she put away herself, and "Put it back" gives it
 * another week from the moment it came back.
 */
export const PUT_AWAY_AFTER_DAYS = 7;
const AGED_OUT = `(d.kind <> 'daily_brief' AND d.acknowledged_at IS NULL AND d.dismissed_at IS NULL
                   AND COALESCE(d.restored_at, d.created_at) < strftime('%Y-%m-%dT%H:%M:%fZ','now','-${PUT_AWAY_AFTER_DAYS} days'))`;

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

  const stored = await env.WP_OS_DB.prepare(
    input.sourceType && input.sourceId
      ? "SELECT * FROM deliverable WHERE source_type = ?1 AND source_id = ?2"
      : "SELECT * FROM deliverable WHERE id = ?1",
  )
    .bind(...(input.sourceType && input.sourceId ? [input.sourceType, input.sourceId] : [id]))
    .first<DeliverableRow>();

  /*
   * THE READ-BACK USED TO BE A `!`, AND THAT WAS A LATENT CRASH RATHER THAN AN ASSERTION.
   *
   * It reads whatever the INSERT above wrote. A handle that performed no write answers nothing —
   * which is exactly what a PREVIEW run does deliberately (see `services/preview.ts`) — and the `!`
   * turned that into a TypeError three lines later, inside a chain whose callers wrap `deliver()`
   * precisely so a filing failure cannot take the work down with it.
   *
   * The deliverable object is the real rendered artifact either way: the title, the body and who it
   * is for are the caller's own values, not the database's. So the row is built from them when the
   * table did not answer, and the caller gets what it always got — a deliverable it can link to and
   * render. Nothing is invented: `document_id` stays null, because no document was filed.
   */
  const row: DeliverableRow = stored ?? {
    id,
    kind: input.kind,
    title: input.title,
    body: input.body,
    prepared_by: input.preparedBy,
    prepared_for: input.preparedFor,
    source_type: input.sourceType ?? null,
    source_id: input.sourceId ?? null,
    privacy_label: privacy,
    firm_scope: firmScope,
    document_id: null,
    created_at: new Date().toISOString(),
  } as DeliverableRow;

  /*
   * NOT EVERYTHING IS WORTH FILING. A morning brief is read once, on the morning it is about, and
   * superseded the next day — three hundred and sixty-five of them a year turns Documents into a
   * place nobody looks, which is what the operator found there. The brief is not lost: it lives in
   * full on Home and in `intelligence_report`. Only the second copy stops being made.
   */
  if (!row.document_id && kindDef(row.kind)?.file !== false) {
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
  /*
   * DISMISSED IS HIDDEN, NOT GONE. The default view is what still wants attention; `?dismissed=1`
   * is how you get the rest back. Deleting was the obvious alternative and the wrong one — a
   * partner clearing a busy page should not be able to destroy the week's work with one click.
   */
  const dismissed = url.searchParams.get("dismissed") === "1";
  // Put away by hand OR by age; the row says which (`put_away`), so the page can say "after a week".
  const dismissClause = dismissed ? `(d.dismissed_at IS NOT NULL OR ${AGED_OUT})` : `(d.dismissed_at IS NULL AND NOT ${AGED_OUT})`;
  /*
   * "PREPARED FOR YOU" HAS TO MEAN FOR YOU.
   *
   * Sharing is right for research — the operator asked for it in those words, so that if Scooter
   * commissions something she can find it. It is wrong for a morning brief, which is addressed,
   * personal, and signed by that partner's own chief of staff. Home listed both under "Prepared for
   * you", and because Scooter's brief was generated later in the day it sat ABOVE hers, signed by
   * Walker — so the page appeared to say her chief of staff had changed.
   *
   * `mine=1` filters to the reader. Everywhere that stays shared now labels whose it is instead of
   * leaving the byline to be misread.
   */
  const mineOnly = url.searchParams.get("mine") === "1";
  const mineClause = mineOnly ? "prepared_for = ?mine" : "1=1";

  /*
   * A MORNING BRIEF IS SUPERSEDED BY THE NEXT MORNING'S, AND ONLY THE LATEST IS STILL A DELIVERY.
   *
   * Operator, 9 Sep 2026, about Scooter's Home page: "make sure his home page is cleared of things
   * to be put away and old briefings just surface the latest 1".
   *
   * She is describing a real backlog. `fu_scooter_taylor` has never signed in — zero events on the
   * spine, zero notifications read, zero approvals decided, zero deliverables acknowledged or
   * dismissed — and 20 deliverables have accumulated against his name, 13 of them daily briefs
   * going back to 20 August. His first sight of this product would have been a stack of superseded
   * morning briefs he had no part in creating, each offering him a Dismiss button for a decision he
   * never made.
   *
   * DERIVED, NOT WRITTEN, and that is the whole point. Marking them dismissed would record that he
   * decided something about documents he has never seen — the same state-confusion as an unread
   * badge that cannot tell "handled" from "acknowledged". Nothing is written here at all: an older
   * brief simply stops being CURRENT, because the next one replaced it. It stays in the database,
   * stays on `?superseded=1`, and stays in `intelligence_report` in full.
   *
   * ONLY `daily_brief`. A weekly review, a research packet and a discrepancy register are referred
   * back to; a brief is read on the morning it is about and replaced by breakfast the next day —
   * which is the same reasoning that already stops briefs being filed into Documents at all
   * (`kindDef('daily_brief').file === false`).
   *
   * PER RECIPIENT, so her latest never supersedes his.
   */
  const superseded = url.searchParams.get("superseded") === "1";
  const currentClause = superseded
    ? "1=1"
    : `(d.kind <> 'daily_brief' OR d.created_at = (
         SELECT MAX(d2.created_at) FROM deliverable d2
          WHERE d2.kind = 'daily_brief' AND d2.prepared_for = d.prepared_for
            AND d2.firm_scope = d.firm_scope))`;

  /*
   * AN ARCHIVED KIND IS OFF THE SHELF, NOT OUT OF THE DATABASE. The weekly review was archived on
   * 18 Sep 2026 (owner: "we don't need it anymore"); nothing produces one now, and the unfiltered
   * shelf on Home would otherwise keep showing the last ones written as if they were current work.
   * Asking for the kind by name (`?kind=weekly_review`) still returns every row, and each is still
   * readable by URL. The list of archived kinds is derived from the kind definitions, so archiving
   * a kind is one field on its definition and never a second list here.
   */
  const archived = archivedDeliverableKinds();
  const archivedClause = archived.length > 0 ? `d.kind NOT IN (${archived.map((k) => `'${k}'`).join(", ")})` : "1=1";

  // BOTH PARTNERS SEE EACH OTHER'S. Research is INTERNAL by default, and the operator's question was
  // explicitly "if scooter requests research i can find it". Anything labelled more sensitive is
  // filtered by the visibility clause, which is where that decision belongs.
  // The reader's name travels with each row so a shared list can say whose a piece is without a
  // second request per row.
  const select = `SELECT d.*, (SELECT full_name FROM firm_user u WHERE u.id = d.prepared_for) AS prepared_for_name,
                         CASE WHEN d.dismissed_at IS NOT NULL THEN 'BY_YOU' WHEN ${AGED_OUT} THEN 'AFTER_A_WEEK' END AS put_away
                    FROM deliverable d`;
  const me = ctx.identity!.id;
  const rows = kind
    ? await ctx.env.WP_OS_DB.prepare(
        `${select} WHERE kind = ?1 AND ${dismissClause} AND ${currentClause}
            AND ${mineClause.replace("?mine", "?3")} AND ${visibility}
          ORDER BY created_at DESC LIMIT ?2`,
      )
        .bind(...(mineOnly ? [kind, limit, me] : [kind, limit]))
        .all<DeliverableRow>()
    : await ctx.env.WP_OS_DB.prepare(
        `${select} WHERE ${dismissClause} AND ${currentClause} AND ${archivedClause}
            AND ${mineClause.replace("?mine", "?2")} AND ${visibility}
          ORDER BY created_at DESC LIMIT ?1`,
      )
        .bind(...(mineOnly ? [limit, me] : [limit]))
        .all<DeliverableRow>();

  return json({
    deliverables: rows.results ?? [],
    put_away_after_days: PUT_AWAY_AFTER_DAYS,
    note: `A morning brief is replaced by the next one. Anything else not marked as read within ${PUT_AWAY_AFTER_DAYS} days is put away by itself and can be put back.`,
  });
}

/*
 * ── Answering something that was prepared for you ────────────────────────────
 *
 * Three verbs, and the difference between them is the whole design.
 *
 * ACKNOWLEDGE says "I read it". The piece stays exactly where it is; it simply stops being one of
 * the things waiting on you. This is the common case and it is deliberately one click with no
 * dialogue — anything heavier and nobody does it, and an unacknowledged pile is the state we were
 * already in.
 *
 * DISMISS says "I did not want this". It leaves the page. It does NOT leave the database, and the
 * page carries a way back, because the first question the operator asked about dismissing was
 * "should I bring it back?" — and a feature whose answer to that is "no, it's gone" is one people
 * learn not to use.
 *
 * FEEDBACK is the one that changes anything. A note addressed to the employee who signed the piece,
 * kept against their name, so their next run can be told what the partner thought of the last one.
 * Without it the other two are filing; with it they are management.
 */
const feedbackSchema = z.object({
  note: z.string().trim().min(1).max(2000),
  verdict: z.enum(["GOOD", "NOT_WHAT_I_WANTED", "TOO_LONG", "WRONG_FOCUS", "NOTE"]).default("NOTE"),
});

export async function handleAcknowledgeDeliverable(ctx: RouteContext): Promise<Response> {
  const row = await loadVisible(ctx, ctx.params.id!);
  if (!row) return json({ error: "not_found" }, { status: 404 });
  await ctx.env.WP_OS_DB.prepare(
    `UPDATE deliverable SET acknowledged_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), acknowledged_by = ?2 WHERE id = ?1`,
  )
    .bind(row.id, ctx.identity!.id)
    .run();
  await appendEvent(ctx.env, {
    eventType: "deliverable.acknowledged",
    actorType: "firm_user",
    actorId: ctx.identity!.id,
    objectType: "deliverable",
    objectId: row.id,
    firmScope: row.firm_scope,
    payload: { kind: row.kind, title: row.title },
  });
  return json({ ok: true, acknowledged: true });
}

export async function handleDismissDeliverable(ctx: RouteContext): Promise<Response> {
  const row = await loadVisible(ctx, ctx.params.id!);
  if (!row) return json({ error: "not_found" }, { status: 404 });
  // Idempotent both ways: dismissing a dismissed row and restoring a live one are both fine, and
  // neither is an error worth showing a partner.
  const restore = new URL(ctx.request.url).searchParams.get("restore") === "1";
  // Putting it back also restarts the week: a row rescued from the age rule would otherwise be
  // put away again on the next read, and the button would appear to do nothing.
  await ctx.env.WP_OS_DB.prepare(
    restore
      ? "UPDATE deliverable SET dismissed_at = NULL, dismissed_by = NULL, restored_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1"
      : "UPDATE deliverable SET dismissed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), dismissed_by = ?2 WHERE id = ?1",
  )
    .bind(...(restore ? [row.id] : [row.id, ctx.identity!.id]))
    .run();
  await appendEvent(ctx.env, {
    eventType: restore ? "deliverable.restored" : "deliverable.dismissed",
    actorType: "firm_user",
    actorId: ctx.identity!.id,
    objectType: "deliverable",
    objectId: row.id,
    firmScope: row.firm_scope,
    payload: { kind: row.kind, title: row.title },
  });
  return json({ ok: true, dismissed: !restore });
}

export async function handleDeliverableFeedback(ctx: RouteContext): Promise<Response> {
  const row = await loadVisible(ctx, ctx.params.id!);
  if (!row) return json({ error: "not_found" }, { status: 404 });
  const parsed = feedbackSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });

  /*
   * A JOINT BYLINE IS TWO EMPLOYEES, NOT A NAME.
   *
   * The weekly operating review is signed "Walker and Wren", and the first cut of this stored the
   * feedback against that whole string. `recentFeedbackFor("Walker")` matches on the employee's
   * name, so the note would have reached neither of them — a feedback feature that silently posts
   * into a void is worse than none, because the partner believes they have been heard.
   *
   * One row per named employee. Both are told, both carry it into their next run, and the note
   * itself is identical because it was one piece of work.
   */
  const recipients = row.prepared_by.split(/\s+and\s+/i).map((n) => n.trim()).filter(Boolean);
  const ids: string[] = [];
  for (const to of recipients.length > 0 ? recipients : [row.prepared_by]) {
    const id = `dfb_${crypto.randomUUID()}`;
    ids.push(id);
    await ctx.env.WP_OS_DB.prepare(
      `INSERT INTO deliverable_feedback (id, deliverable_id, to_employee, from_user_id, note, verdict, firm_scope)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
      .bind(id, row.id, to, ctx.identity!.id, parsed.data.note, parsed.data.verdict, row.firm_scope)
      .run();
  }
  const id = ids[0]!;

  await appendEvent(ctx.env, {
    eventType: "deliverable.feedback_left",
    actorType: "firm_user",
    actorId: ctx.identity!.id,
    objectType: "deliverable",
    objectId: row.id,
    firmScope: row.firm_scope,
    payload: { to_employees: recipients, verdict: parsed.data.verdict },
  });
  return json({ ok: true, id }, { status: 201 });
}

export async function handleListDeliverableFeedback(ctx: RouteContext): Promise<Response> {
  const row = await loadVisible(ctx, ctx.params.id!);
  if (!row) return json({ error: "not_found" }, { status: 404 });
  const rows = await ctx.env.WP_OS_DB.prepare(
    "SELECT * FROM deliverable_feedback WHERE deliverable_id = ?1 ORDER BY created_at DESC",
  )
    .bind(row.id)
    .all();
  return json({ feedback: rows.results ?? [] });
}

/**
 * What a partner has said about this employee's recent work, for their next run's prompt.
 *
 * THE POINT OF THE WHOLE FEATURE. Feedback that only a human ever reads is a comment box. This is
 * the function that makes it management: an employee about to write another brief is told what the
 * partner thought of the last three, in the partner's own words.
 */
export async function recentFeedbackFor(env: Env, employeeName: string, limit = 3): Promise<string> {
  const rows = await env.WP_OS_DB.prepare(
    "SELECT note, verdict, created_at FROM deliverable_feedback WHERE to_employee = ?1 ORDER BY created_at DESC LIMIT ?2",
  )
    .bind(employeeName, limit)
    .all<{ note: string; verdict: string; created_at: string }>()
    .catch(() => ({ results: [] }));
  const notes = rows.results ?? [];
  if (notes.length === 0) return "";
  return [
    "WHAT THE PARTNERS SAID ABOUT YOUR LAST PIECES — take this seriously, it is the point of doing this again:",
    ...notes.map((n) => `  · (${n.verdict.toLowerCase().replace(/_/g, " ")}) ${n.note}`),
    "",
  ].join("\n");
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

  // THE SAME LAYOUT AS EVERYTHING ELSE AN EMPLOYEE SENDS (16 Sep 2026): the copy arrives with a
  // TL;DR and the piece's own headings as the summary, the full markdown under the rule, signed
  // by whoever prepared it. `sendFirmUserCopy` is the one transport door and records the send.
  const markdown = renderMarkdown(toExport(row, recipient.full_name));
  const result = await sendFirmUserCopy(ctx.env, {
    recipient: { id: recipient.id, email: recipient.email },
    email: copyEmail(row, recipient.full_name, markdown),
    objectType: "deliverable",
    objectId: row.id,
    firmScope: row.firm_scope,
    byFirmUserId: ctx.identity!.id,
  });

  return json({ sent: result.sent, detail: result.reason, to: recipient.full_name });
}

/**
 * A deliverable as a busy-executive email: what it is, what is in it (its own headings), and the
 * whole thing below the rule. Signed by the employee who prepared it.
 */
export function copyEmail(row: Pick<DeliverableRow, "kind" | "title" | "body" | "prepared_by" | "created_at">, forName: string, markdown: string): ExecEmailInput {
  const label = kindDef(row.kind)?.label ?? "Deliverable";
  const headings = row.body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^#{1,3}\s+\S/.test(l))
    .map((l) => l.replace(/^#+\s+/, ""));
  const firstLines = row.body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !isBulletOrLabel(l) && !l.startsWith("_"))
    .slice(0, 2);
  const employee = row.prepared_by.split(/\s+and\s+/i)[0]?.trim() || row.prepared_by;
  return {
    employee,
    what: `${label.toLowerCase()} — ${row.title}`,
    tldr: `A copy of the ${label.toLowerCase()} "${row.title}", as you asked from Home. Nothing to decide.`,
    sections: [
      { label: "What this is", bullets: [`${label}, prepared for **${forName}** by **${row.prepared_by}** on ${new Date(row.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}.`] },
      { label: "What is in it", bullets: headings.length ? headings : firstLines.length ? firstLines : ["The full text is below."] },
    ],
    details: markdown,
  };
}

// === Home overhaul ===
/*
 * MANY AT ONCE, ONE HONEST ANSWER (design/HOME_DESIGN.md §3.4, 19 Sep 2026).
 *
 * Production, 20 Aug → 19 Sep: 24 of 57 deliverables put away by hand, one press each; 4 read.
 * "The open things below have to be opened one by one and can't all be dismissed." So the Arrived
 * band gets `Mark all read` and select-many, and each lands here as ONE request rather than N: a
 * partial failure is then one sentence — which ids were done and which were not — instead of N
 * separate results the page would have to reconcile.
 *
 * ZERO IDS IS A REFUSAL, NOT A NO-OP. A batch route that answers 200 to an empty list is the "runs
 * but inert" shape: a page that lost its selection would report success having done nothing.
 */
const manySchema = z.object({ ids: z.array(z.string().trim().min(1)).min(1, "at least one id").max(200) });

async function markMany(ctx: RouteContext, kind: "acknowledge" | "dismiss"): Promise<Response> {
  const parsed = manySchema.safeParse(await ctx.request.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_input", detail: "ids: a non-empty list of deliverable ids", issues: parsed.error.issues }, { status: 400 });
  const done: string[] = [];
  const missing: string[] = [];
  for (const id of parsed.data.ids) {
    const row = await loadVisible(ctx, id);
    if (!row) { missing.push(id); continue; }
    if (kind === "acknowledge") {
      await ctx.env.WP_OS_DB.prepare(`UPDATE deliverable SET acknowledged_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), acknowledged_by = ?2 WHERE id = ?1`).bind(row.id, ctx.identity!.id).run();
    } else {
      await ctx.env.WP_OS_DB.prepare(`UPDATE deliverable SET dismissed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), dismissed_by = ?2 WHERE id = ?1`).bind(row.id, ctx.identity!.id).run();
    }
    await appendEvent(ctx.env, {
      eventType: kind === "acknowledge" ? "deliverable.acknowledged" : "deliverable.dismissed",
      actorType: "firm_user",
      actorId: ctx.identity!.id,
      objectType: "deliverable",
      objectId: row.id,
      firmScope: row.firm_scope,
      payload: { kind: row.kind, title: row.title, batch: parsed.data.ids.length },
    });
    done.push(row.id);
  }
  await appendEvent(ctx.env, {
    eventType: kind === "acknowledge" ? "home.mark_all_read" : "home.dismiss_many",
    actorType: "firm_user",
    actorId: ctx.identity!.id,
    objectType: "deliverable",
    objectId: "many",
    firmScope: "west-peek",
    payload: { asked: parsed.data.ids.length, done: done.length, missing: missing.length },
  });
  return json({ ok: missing.length === 0, done, missing, note: missing.length ? `${missing.length} of ${parsed.data.ids.length} could not be found or are not yours to change.` : null }, { status: missing.length ? 207 : 200 });
}

/** POST /api/deliverables/acknowledge-many {ids} — Mark all read. */
export async function handleAcknowledgeMany(ctx: RouteContext): Promise<Response> {
  return markMany(ctx, "acknowledge");
}

/** POST /api/deliverables/dismiss-many {ids} — Put the selected away. */
export async function handleDismissMany(ctx: RouteContext): Promise<Response> {
  return markMany(ctx, "dismiss");
}
