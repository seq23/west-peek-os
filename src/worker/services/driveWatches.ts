import type { Env } from "../env";
import { json, type RouteContext } from "../router";
import { SUBSCRIPTION_CLAIMER_EMAIL } from "../auth";
import { appendEvent } from "../events";
import { sendOrPreview } from "./previewApproval";
import { partnerByEmail } from "../../shared/registry/partners";
import { waitBullets } from "../../shared/work/porterWaits";
import { driveFoldersIn } from "../../shared/work/partnerPractices";

/**
 * A DRIVE FOLDER THE ASK NAMED IS WATCHED UNTIL ITS FILES ARRIVE (R21, addendum item 10, 0254).
 *
 * Owner's addendum, 6 Oct 2026: when an ask names Drive folders, the job watches them and loads on
 * arrival with no new email; "still empty" is reported once. For every kind, not only Porter's.
 *
 *   1 · THE DOOR (`recordDriveWatches`, called by `dealIntake.openAssignmentCard` for every emailed
 *       ask) records each folder link in the partner's words as a `drive_watch` row on the card.
 *   2 · THE SWEEP ON THE MAC: the claimer's heartbeat asks `/api/drive-watches/pending` for the rows
 *       due (every 15 minutes), maps each folder with `scripts/drive/pull.mjs --map` under the
 *       vault's service account, and reports what it saw to `/api/drive-watches/status`.
 *   3 · FILES → LOADED ON ARRIVAL: the card (and any live card it was handed to) gets the file names
 *       and the documents' text as a note from the partner — the note every runner's `steerFor` and
 *       the general loop already read — and a blocked card is answered the way the "I added missing
 *       items" button answers it (`materialsAdded`). No new email from anyone.
 *   4 · EMPTY → SAID ONCE: the first empty check emails the partner the three-part DRIVE_EMPTY wait
 *       and stamps `empty_told_at`; later empty checks say nothing. After WATCH_DAYS the row closes.
 */

export const DRIVE_RECHECK_MINUTES = 15;
export const DRIVE_WATCH_DAYS = 14;

export interface DriveWatchRow {
  id: string;
  work_card_id: string;
  folder_id: string;
  folder_url: string;
  requested_by: string;
  status: "WATCHING" | "ARRIVED" | "CLOSED";
  files_seen: number;
  empty_told_at: string | null;
  arrived_at: string | null;
  last_checked_at: string | null;
  firm_scope: string;
  created_at: string;
}

/** Record every Drive folder the partner's words name on the card. Returns the folder ids recorded. */
export async function recordDriveWatches(env: Env, input: { cardId: string; text: string; requestedBy: string | null; firmScope: string }): Promise<string[]> {
  const partner = partnerByEmail(input.requestedBy);
  if (!partner) return [];
  const out: string[] = [];
  for (const f of driveFoldersIn(input.text)) {
    const res = await env.WP_OS_DB.prepare(
      "INSERT OR IGNORE INTO drive_watch (id, work_card_id, folder_id, folder_url, requested_by, firm_scope) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )
      .bind(`dw_${crypto.randomUUID()}`, input.cardId, f.id, f.url.slice(0, 500), partner.email.toLowerCase(), input.firmScope)
      .run();
    if ((res.meta?.changes ?? 0) > 0) out.push(f.id);
  }
  if (out.length) {
    await appendEvent(env, { eventType: "drive_watch.recorded", actorType: "system", actorId: "drive_watch", objectType: "work_card", objectId: input.cardId, firmScope: input.firmScope, payload: { folders: out } });
  }
  return out;
}

/** The card and every live card it was handed to — where arrived files must land. */
async function liveCardsFor(env: Env, cardId: string): Promise<Array<{ id: string; kind: string | null; state: string; firm_scope: string }>> {
  const rows = await env.WP_OS_DB.prepare(
    `SELECT id, kind, state, firm_scope FROM work_card
      WHERE (id = ?1 OR assigned_from_card_id = ?1) AND state NOT IN ('DONE', 'CANCELLED')`,
  )
    .bind(cardId)
    .all<{ id: string; kind: string | null; state: string; firm_scope: string }>();
  return rows.results ?? [];
}

/** What a card is told when files arrive: the names, and the documents' text, so the next run uses them. */
export function arrivalNote(row: Pick<DriveWatchRow, "folder_url">, names: readonly string[], documents: ReadonlyArray<{ name: string; text: string }>): string {
  const docs = documents
    .filter((d) => String(d.text ?? "").trim())
    .slice(0, 8)
    .map((d) => `--- ${d.name} ---\n${String(d.text).slice(0, 3000)}`);
  return [
    `I added missing items — files arrived in the Drive folder named in the ask (${row.folder_url}): ${names.slice(0, 40).join(", ")}${names.length > 40 ? `, and ${names.length - 40} more` : ""}.`,
    "Use them for this work; nobody needs to be asked for them again.",
    ...(docs.length ? ["", "THE DOCUMENTS' TEXT:", ...docs] : []),
  ]
    .join("\n")
    .slice(0, 3900);
}

async function tellEmptyOnce(env: Env, row: DriveWatchRow): Promise<boolean> {
  const partner = partnerByEmail(row.requested_by);
  if (!partner) return false;
  const card = await env.WP_OS_DB.prepare("SELECT c.title, e.name AS employee FROM work_card c LEFT JOIN ai_employee e ON e.id = c.owner_id WHERE c.id = ?1")
    .bind(row.work_card_id)
    .first<{ title: string; employee: string | null }>();
  const employee = card?.employee ?? "Porter";
  const bullets = waitBullets("DRIVE_EMPTY", { what: row.folder_url });
  const what = "the Drive folder is still empty";
  try {
    const out = await sendOrPreview(env, {
      to: partner.email,
      email: {
        employee,
        what,
        tldr: `The Drive folder you named for "${(card?.title ?? "your ask").slice(0, 80)}" is still empty. Everything that does not need it is going ahead; the files load by themselves the moment they are in — no new email needed. This is the only time I will say so.`,
        sections: [
          { label: "Where things stand", bullets },
          { label: "Your call", bullets: ["Nothing, unless it is the wrong folder — then reply with the right link."] },
        ],
      },
      objectType: "work_card",
      objectId: row.work_card_id,
      firmScope: row.firm_scope,
      actorId: "drive_watch",
      cardKind: null,
      cardAsked: null,
      tickedByFirmUserId: null,
      requestedByEmail: partner.email,
      what,
      workCardId: row.work_card_id,
    });
    return out.sent || out.previewed;
  } catch {
    return false;
  }
}

/**
 * THE MAC'S REPORT, APPLIED. Pure over the database: files → loaded onto every live card and the row
 * ARRIVED; none → told once, then silent; past the watch window → CLOSED. Returns what it did.
 */
export async function applyDriveWatchStatus(
  env: Env,
  row: DriveWatchRow,
  report: { files: number; names?: readonly string[]; documents?: ReadonlyArray<{ name: string; text: string }> },
  now: Date = new Date(),
): Promise<"loaded" | "told_empty" | "still_empty" | "closed"> {
  const at = now.toISOString();
  await env.WP_OS_DB.prepare("UPDATE drive_watch SET last_checked_at = ?2, files_seen = ?3, updated_at = ?2 WHERE id = ?1").bind(row.id, at, Math.max(0, report.files | 0)).run();
  const cards = await liveCardsFor(env, row.work_card_id);
  if (cards.length === 0) {
    await env.WP_OS_DB.prepare("UPDATE drive_watch SET status = 'CLOSED', updated_at = ?2 WHERE id = ?1").bind(row.id, at).run();
    return "closed";
  }
  if (report.files > 0) {
    const partner = partnerByEmail(row.requested_by);
    const note = arrivalNote(row, report.names ?? [], report.documents ?? []);
    const { materialsAdded } = await import("./webPropertyChange");
    for (const card of cards) {
      if (partner) await materialsAdded(env, card, partner.firmUserId, `Files arrived in the Drive folder named in the ask (${row.folder_url}).`, note);
    }
    await env.WP_OS_DB.prepare("UPDATE drive_watch SET status = 'ARRIVED', arrived_at = ?2, updated_at = ?2 WHERE id = ?1").bind(row.id, at).run();
    await appendEvent(env, { eventType: "drive_watch.arrived", actorType: "system", actorId: "drive_watch", objectType: "work_card", objectId: row.work_card_id, firmScope: row.firm_scope, payload: { folder: row.folder_id, files: report.files, cards: cards.map((c) => c.id) } });
    return "loaded";
  }
  if (now.getTime() - Date.parse(row.created_at) > DRIVE_WATCH_DAYS * 86_400_000) {
    await env.WP_OS_DB.prepare("UPDATE drive_watch SET status = 'CLOSED', updated_at = ?2 WHERE id = ?1").bind(row.id, at).run();
    return "closed";
  }
  if (!row.empty_told_at) {
    // Stamped BEFORE the send: "said once" holds even if two reports race; a failed send is not retried into a second email.
    const claimed = await env.WP_OS_DB.prepare("UPDATE drive_watch SET empty_told_at = ?2 WHERE id = ?1 AND empty_told_at IS NULL").bind(row.id, at).run();
    if ((claimed.meta?.changes ?? 0) > 0) {
      await tellEmptyOnce(env, row);
      return "told_empty";
    }
  }
  return "still_empty";
}

function isClaimer(ctx: RouteContext): boolean {
  return ctx.identity?.email.toLowerCase() === SUBSCRIPTION_CLAIMER_EMAIL;
}

/** POST /api/drive-watches/pending — the claimer only: folders still being watched and due a look. */
export async function handlePendingDriveWatches(ctx: RouteContext): Promise<Response> {
  if (!isClaimer(ctx)) return json({ error: "forbidden", detail: "Only the Mac's claimer checks Drive folders." }, { status: 403 });
  const due = new Date(Date.now() - DRIVE_RECHECK_MINUTES * 60_000).toISOString();
  const rows = await ctx.env.WP_OS_DB.prepare(
    `SELECT id, folder_id, folder_url FROM drive_watch
      WHERE status = 'WATCHING' AND (last_checked_at IS NULL OR last_checked_at < ?1)
      ORDER BY created_at ASC LIMIT 10`,
  )
    .bind(due)
    .all<{ id: string; folder_id: string; folder_url: string }>();
  return json({ watches: rows.results ?? [] });
}

/** POST /api/drive-watches/status { id, files, names?, documents? } — what the Mac saw in the folder. */
export async function handleDriveWatchStatus(ctx: RouteContext): Promise<Response> {
  if (!isClaimer(ctx)) return json({ error: "forbidden", detail: "Only the Mac's claimer checks Drive folders." }, { status: 403 });
  const body = (await ctx.request.json().catch(() => ({}))) as { id?: string; files?: number; names?: unknown; documents?: unknown };
  const id = String(body.id ?? "").trim();
  if (!id) return json({ error: "invalid_input", detail: "id is required" }, { status: 400 });
  const row = await ctx.env.WP_OS_DB.prepare("SELECT * FROM drive_watch WHERE id = ?1").bind(id).first<DriveWatchRow>();
  if (!row) return json({ error: "not_found", detail: "no such watch" }, { status: 404 });
  if (row.status !== "WATCHING") return json({ ok: true, did: "already_" + row.status.toLowerCase() });
  const names = Array.isArray(body.names) ? body.names.map((n) => String(n).slice(0, 200)).slice(0, 200) : [];
  const documents = Array.isArray(body.documents)
    ? (body.documents as Array<{ name?: unknown; text?: unknown }>).slice(0, 8).map((d) => ({ name: String(d?.name ?? "").slice(0, 200), text: String(d?.text ?? "").slice(0, 4000) }))
    : [];
  const did = await applyDriveWatchStatus(ctx.env, row, { files: Number(body.files) || 0, names, documents });
  return json({ ok: true, did });
}
