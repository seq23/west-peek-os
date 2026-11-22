import type { Env } from "../env";
import { appendEvent } from "../events";
import { sendOrPreview } from "./previewApproval";
import { PARTNERS, partnerByEmail } from "../../shared/registry/partners";
import { DRIVE_RECHECK_MINUTES, waitBullets } from "../../shared/work/porterWaits";
import { GoogleWorkspaceError, SCOPE, driveFileText, listDriveChildren, serviceAccountToken, type DriveFileRaw } from "../effects/googleWorkspaceClient";
import { PARTNER_MATERIAL_GRACE_MINUTES, driveFoldersIn } from "../../shared/work/partnerPractices";

/**
 * A DRIVE FOLDER THE ASK NAMED IS WATCHED UNTIL ITS FILES ARRIVE (R21, addendum item 10, 0254).
 *
 * Owner's addendum, 6 Oct 2026: when an ask names Drive folders, the job watches them and loads on
 * arrival with no new email; "still empty" is reported once. For every kind, not only Porter's.
 *
 *   1 · THE DOOR (`recordDriveWatches`, called by `dealIntake.openAssignmentCard` for every emailed
 *       ask) records each folder link in the partner's words as a `drive_watch` row on the card.
 *   2 · THE SWEEP ON THE WORKER'S CRON (`sweepDriveWatches`, 22 Nov 2026): every row due (every
 *       DRIVE_RECHECK_MINUTES, day and night) is read with the service account (`readWatchedFolder`).
 *   3 · FILES → LOADED ON ARRIVAL: the card (and any live card it was handed to) gets the file names
 *       and the documents' text as a note from the partner — the note every runner's `steerFor` and
 *       the general loop already read — and a blocked card is answered the way the "I added missing
 *       items" button answers it (`materialsAdded`). No new email from anyone.
 *   4 · EMPTY → SAID ONCE: the first empty check after the grace period
 *       (PARTNER_MATERIAL_GRACE_MINUTES from when the ask named the folder, #354) emails the partner the three-part DRIVE_EMPTY wait
 *       and stamps `empty_told_at`; later empty checks say nothing. After WATCH_DAYS the row closes.
 */

export { DRIVE_RECHECK_MINUTES };
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
 * WHAT THE FOLDER HELD, APPLIED. Pure over the database: files → loaded onto every live card and the row
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
  // #354: a folder he just named gets the grace period to fill before anybody says it is empty.
  if (!row.empty_told_at && now.getTime() - Date.parse(row.created_at) >= PARTNER_MATERIAL_GRACE_MINUTES * 60_000) {
    // Stamped BEFORE the send: "said once" holds even if two reports race; a failed send is not retried into a second email.
    const claimed = await env.WP_OS_DB.prepare("UPDATE drive_watch SET empty_told_at = ?2 WHERE id = ?1 AND empty_told_at IS NULL").bind(row.id, at).run();
    if ((claimed.meta?.changes ?? 0) > 0) {
      await tellEmptyOnce(env, row);
      return "told_empty";
    }
  }
  return "still_empty";
}

const TEXT_DOC = /\.(txt|md|csv|json)$/i;
const GOOGLE_TEXT = new Set(["application/vnd.google-apps.document", "application/vnd.google-apps.spreadsheet", "application/vnd.google-apps.presentation"]);
const FOLDER = "application/vnd.google-apps.folder";
const MAX_FILES = 200;
const MAX_DEPTH = 3;

export type FolderRead = { files: number; names: string[]; documents: Array<{ name: string; text: string }> } | { outage: string };

/**
 * WHAT IS IN THE FOLDER, READ BY THE WORKER (22 Nov 2026). The same service account the Mac used (drive.readonly,
 * domain-wide delegation), as the partner who named the folder first and then the other partner, so a folder shared
 * with either is seen. Walks sub-folders (depth 3, 200 files); carries the text of up to eight small documents.
 * A folder nobody can see is ZERO files ("empty, or not yet shared", which is what DRIVE_EMPTY says); a key, scope
 * or network fault is an OUTAGE, never zero, so nobody is told "still empty" because Google was down.
 */
export async function readWatchedFolder(env: Env, row: Pick<DriveWatchRow, "folder_id" | "requested_by">, fetchImpl: typeof fetch = fetch): Promise<FolderRead> {
  const first = partnerByEmail(row.requested_by);
  const subjects = [...(first ? [first] : []), ...PARTNERS.filter((p) => p.email !== first?.email)];
  for (const p of subjects) {
    let token: string;
    try {
      token = await serviceAccountToken(env, [SCOPE.driveRead], p.email, fetchImpl);
    } catch (err) {
      return { outage: err instanceof Error ? err.message.slice(0, 200) : String(err) };
    }
    try {
      const names: string[] = [];
      const files: Array<{ raw: DriveFileRaw; path: string }> = [];
      const walk = async (id: string, prefix: string, depth: number): Promise<void> => {
        for (const f of await listDriveChildren(token, id, fetchImpl)) {
          if (files.length >= MAX_FILES) return;
          const path = `${prefix}${f.name ?? "(unnamed)"}`;
          if (f.mimeType === FOLDER) {
            if (depth < MAX_DEPTH && f.id) await walk(f.id, `${path}/`, depth + 1);
            continue;
          }
          files.push({ raw: f, path });
          names.push(path);
        }
      };
      await walk(row.folder_id, "", 1);
      const documents: Array<{ name: string; text: string }> = [];
      for (const f of files.filter((x) => GOOGLE_TEXT.has(x.raw.mimeType ?? "") || (TEXT_DOC.test(x.path) && Number(x.raw.size ?? 0) <= 200_000)).slice(0, 8)) {
        try {
          const text = await driveFileText(token, { ...f.raw, mimeType: TEXT_DOC.test(f.path) && !GOOGLE_TEXT.has(f.raw.mimeType ?? "") ? "text/plain" : f.raw.mimeType }, 4000, fetchImpl);
          if (text) documents.push({ name: f.path, text });
        } catch {
          // A document that would not export is still named; its text is simply not carried.
        }
      }
      return { files: files.length, names, documents };
    } catch (err) {
      if (err instanceof GoogleWorkspaceError && (err.code === "not_found" || err.code === "forbidden")) continue;
      return { outage: err instanceof Error ? err.message.slice(0, 200) : String(err) };
    }
  }
  return { files: 0, names: [], documents: [] };
}

/**
 * THE WATCH, ON THE WORKER'S CRON (22 Nov 2026). It used to ride the Mac claimer's heartbeat, which since #572 runs
 * only 10:00-21:59 CT, so "loaded within 15 minutes" was false all night. Every folder not looked at in
 * DRIVE_RECHECK_MINUTES is read now, day or night, and the answer applied exactly as before. An outage stamps the
 * look (so it is retried on the next interval, not every minute) and applies nothing.
 */
export async function sweepDriveWatches(env: Env, now: Date, fetchImpl: typeof fetch = fetch): Promise<Array<{ folder: string; did: string }>> {
  const due = new Date(now.getTime() - DRIVE_RECHECK_MINUTES * 60_000).toISOString();
  const rows =
    (
      await env.WP_OS_DB.prepare(
        `SELECT * FROM drive_watch WHERE status = 'WATCHING' AND (last_checked_at IS NULL OR last_checked_at <= ?1)
          ORDER BY last_checked_at ASC LIMIT 10`,
      )
        .bind(due)
        .all<DriveWatchRow>()
    ).results ?? [];
  const out: Array<{ folder: string; did: string }> = [];
  for (const row of rows) {
    const read = await readWatchedFolder(env, row, fetchImpl);
    if ("outage" in read) {
      await env.WP_OS_DB.prepare("UPDATE drive_watch SET last_checked_at = ?2, updated_at = ?2 WHERE id = ?1").bind(row.id, now.toISOString()).run();
      await appendEvent(env, { eventType: "drive_watch.unread", actorType: "system", actorId: "drive_watch", objectType: "work_card", objectId: row.work_card_id, firmScope: row.firm_scope, payload: { folder: row.folder_id, why: read.outage } });
      out.push({ folder: row.folder_id, did: "unread" });
      continue;
    }
    out.push({ folder: row.folder_id, did: await applyDriveWatchStatus(env, row, read, now) });
  }
  return out;
}
