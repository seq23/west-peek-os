import type { Env } from "../env";
import { appendEvent } from "../events";
import type { DriveShareNotice } from "../../shared/intake/driveShare";
import { PARTNERS, partnerByEmail, type Partner } from "../../shared/registry/partners";
import { WEB_PROPERTY_CHANGE_KIND } from "../../shared/work/localJobs";
import { driveFileText, getDriveFile, GoogleWorkspaceError, SCOPE, serviceAccountToken, type DriveFileRaw } from "../effects/googleWorkspaceClient";
import { createWorkCardInternal } from "./workCards";
import { systemIdentity } from "./dealIntake";
import { blockCard } from "./blocks";
import type { BlockProvider } from "../../shared/work/blocks";
import { loadProfile } from "./partnerProfile";
import { aliasHostsIn, candidateLabel, ctTime, shareQuestionEmail, topicWords, type Candidate } from "./emailRouting";
import { sendPartnerEmail } from "./execEmail";
import { PARTNER_MATERIAL_GRACE_MINUTES, driveIdsIn } from "../../shared/work/partnerPractices";

/**
 * A SHARED DRIVE FILE IS THE SHARING PARTNER'S MATERIAL (9 Oct 2026, 0256).
 *
 * Scooter shared "Official Rules - Top Barz CultureCon Song Contest - Draft II" with os@ two minutes
 * before emailing "New site build: voting.topbarz.xyz/entry". The notice came from Google's share
 * sender, so the door opened an "Unclear email" card that could not even open the document, and asked
 * Sequoia. A share is never unclear:
 *
 *   1 · WHO. Google signs the notice and its Reply-To names the sharer (`shared/intake/driveShare.ts`);
 *       the Drive API, read as that partner through the firm's delegation, confirms he can open it and
 *       names the owner. No signed Reply-To → the file's owner, when the API shows a partner owns it.
 *   2 · WHERE. His open job the document is about — the site his profile says the title names ("Top
 *       Barz" → voting.topbarz.xyz), a host in the title, or the job its title words clearly match —
 *       gets the file attached, text and all. Nothing new is opened.
 *   3 · NO MATCH. A new card for him with the file on it, and ONE plain email: "I got <title> from you
 *       at <time> CT. What would you like me to do with it?" with at most three replies. His reply
 *       routes it; no reply → the card's normal 24-hour reminder (it is BLOCKED on him).
 *       THE EMAIL WAITS A GRACE PERIOD (13 Nov 2026, #354): he shared a folder and, seven seconds
 *       later, emailed the request that links it; the question had already gone. Now the question is
 *       held for PARTNER_MATERIAL_GRACE_MINUTES (`askHeldShareQuestions`, on the sweep). An email of his
 *       that links the file inside the window joins the share to that job and nothing is asked
 *       (`joinSharesNamedIn`); a question already sent is closed the same way, with no further email.
 *   4 · NOBODY. Only when no partner can be identified does the door fall back to asking Sequoia.
 */

export const DRIVE_TEXT_MAX = 20_000;
const DESCRIPTION_TEXT_MAX = 6_000;

export interface SharedFile {
  fileId: string;
  url: string;
  title: string;
  mimeType: string | null;
  sharedBy: string | null;
  sharedAt: string | null;
  text: string | null;
  readError: string | null;
}

/** Read the file as the partner who shared it. Never throws: an unreadable file is attached by its link, with the reason. */
export async function readSharedFile(env: Env, notice: DriveShareNotice, receivedAt: string): Promise<{ partner: Partner | null; file: SharedFile }> {
  const signed = partnerByEmail(notice.sharer);
  const tryAs = signed ? [signed] : [...PARTNERS];
  let lastError: string | null = null;
  for (const p of tryAs) {
    try {
      const token = await serviceAccountToken(env, [SCOPE.driveRead], p.email);
      const raw: DriveFileRaw = await getDriveFile(token, notice.fileId);
      const owner = (raw.owners ?? []).map((o) => (o.emailAddress ?? "").toLowerCase());
      // Without Google's signed Reply-To, the partner is who OWNS it — never merely someone who can see it.
      const partner = signed ?? (owner.includes(p.email) ? p : null);
      if (!partner) continue;
      let text: string | null = null;
      let readError: string | null = null;
      try {
        text = await driveFileText(token, raw, DRIVE_TEXT_MAX);
      } catch (err) {
        readError = err instanceof Error ? err.message : String(err);
      }
      return { partner, file: { fileId: notice.fileId, url: notice.url, title: raw.name || notice.title, mimeType: raw.mimeType ?? null, sharedBy: partner.email, sharedAt: receivedAt, text, readError } };
    } catch (err) {
      lastError = err instanceof GoogleWorkspaceError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err);
    }
  }
  return {
    partner: signed,
    file: { fileId: notice.fileId, url: notice.url, title: notice.title, mimeType: null, sharedBy: signed?.email ?? null, sharedAt: receivedAt, text: null, readError: lastError ?? "not read" },
  };
}

/** Put the file on a card: a row every reader can list, and its words where every employee reads. */
export async function attachDriveFile(env: Env, cardId: string, f: SharedFile, firmScope = "west-peek"): Promise<boolean> {
  const ins = await env.WP_OS_DB.prepare(
    `INSERT OR IGNORE INTO card_drive_file (id, work_card_id, file_id, url, title, mime_type, shared_by, shared_at, text, read_error, firm_scope)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
  )
    .bind(`cdf_${crypto.randomUUID()}`, cardId, f.fileId, f.url, f.title.slice(0, 300), f.mimeType, f.sharedBy, f.sharedAt, f.text, f.readError ? f.readError.slice(0, 300) : null, firmScope)
    .run();
  if ((ins.meta?.changes ?? 0) === 0) return false;
  const who = partnerByEmail(f.sharedBy)?.firstName ?? "A partner";
  const lines = [
    `• SHARED DOCUMENT from ${who} (${f.sharedAt ? ctTime(f.sharedAt) : "today"}): "${f.title}" — ${f.url}`,
    f.text ? `--- "${f.title}", as read through the firm's Drive access (first ${Math.min(f.text.length, DESCRIPTION_TEXT_MAX)} characters) ---\n${f.text.slice(0, DESCRIPTION_TEXT_MAX)}\n--- end of "${f.title}" ---` : `(Its text could not be read here${f.readError ? `: ${f.readError}` : ""}; the link opens it.)`,
  ].join("\n");
  await env.WP_OS_DB.prepare("UPDATE work_card SET description = substr(COALESCE(description, '') || char(10) || ?2, 1, 30000), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1")
    .bind(cardId, lines)
    .run();
  return true;
}

/** The files shared onto a card, for a job's brief. */
export async function driveFilesFor(env: Env, cardId: string): Promise<Array<{ title: string; url: string; shared_by: string | null; text: string | null }>> {
  try {
    return (await env.WP_OS_DB.prepare("SELECT title, url, shared_by, text FROM card_drive_file WHERE work_card_id = ?1 ORDER BY created_at").bind(cardId).all<{ title: string; url: string; shared_by: string | null; text: string | null }>()).results ?? [];
  } catch {
    return [];
  }
}

interface OpenJob {
  id: string;
  title: string;
  property_host: string | null;
  request_json: string | null;
  description?: string | null;
}

/** His open job whose own words link this very file or folder: the email came first, the share second. */
export function jobNamingFile<T extends { description?: string | null; request_json: string | null }>(fileId: string, jobs: readonly T[]): T | null {
  return jobs.find((j) => driveIdsIn(`${j.description ?? ""}\n${j.request_json ?? ""}`).includes(fileId)) ?? null;
}

/** His open job this file is about, or null. Pure over the rows and the profile. */
export function matchShareToJob(title: string, jobs: readonly OpenJob[], aliasHosts: readonly string[]): OpenJob | null {
  const hostsOf = (h: string | null) => String(h ?? "").split(/,\s*/).map((x) => x.trim().toLowerCase()).filter(Boolean);
  const named = new Set([...aliasHosts, ...[...title.toLowerCase().matchAll(/\b((?:[a-z0-9-]+\.)+[a-z]{2,})\b/g)].map((m) => m[1]!)]);
  if (named.size) {
    const same = jobs.filter((j) => hostsOf(j.property_host).some((h) => named.has(h)));
    if (same.length) return same[0]!;
  }
  const mine = topicWords(title);
  const scored = jobs.map((j) => ({ j, s: [...topicWords(`${j.title} ${candidateLabel(j)}`)].filter((w) => mine.has(w)).length })).sort((a, b) => b.s - a.s);
  if (scored[0] && scored[0].s >= 2 && scored[0].s >= 2 * (scored[1]?.s ?? 0)) return scored[0].j;
  return null;
}

async function openJobsOf(env: Env, partner: string): Promise<OpenJob[]> {
  return (
    (
      await env.WP_OS_DB.prepare(
        `SELECT c.id, c.title, c.request_json, c.description, w.property_host FROM work_card c LEFT JOIN web_property_change w ON w.work_card_id = c.id
          WHERE lower(c.requested_by_email) = ?1 AND c.state NOT IN ('DONE', 'CANCELLED') AND c.merged_into_card_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM work_card ch WHERE ch.assigned_from_card_id = c.id)
          ORDER BY (c.kind = ?2) DESC, c.updated_at DESC LIMIT 20`,
      )
        .bind(partner, WEB_PROPERTY_CHANGE_KIND)
        .all<OpenJob>()
    ).results ?? []
  );
}

export interface ShareOutcome {
  handled: boolean;
  cardId: string | null;
  attachedTo?: string;
  asked?: boolean;
}

/**
 * The door's whole handling of a share notice. Returns handled=false only when no partner can be
 * identified — the one case the ladder's "can't place it" question (to Sequoia) still covers.
 */
export async function handleDriveShare(env: Env, input: { notice: DriveShareNotice; receivedAt: string; messageId: string; emlKey: string | null }): Promise<ShareOutcome> {
  const { partner, file } = await readSharedFile(env, input.notice, input.receivedAt);
  if (!partner) return { handled: false, cardId: null };
  const jobs = await openJobsOf(env, partner.email);
  const profile = await loadProfile(env, partner.email);
  const match = jobNamingFile(file.fileId, jobs) ?? matchShareToJob(file.title, jobs, aliasHostsIn(file.title, profile));
  if (match) {
    await attachDriveFile(env, match.id, file);
    await appendEvent(env, {
      eventType: "inbound_email.drive_share_attached",
      actorType: "system",
      actorId: "inbound_email",
      objectType: "work_card",
      objectId: match.id,
      firmScope: "west-peek",
      payload: { file_id: file.fileId, title: file.title, shared_by: partner.email, read: Boolean(file.text), read_error: file.readError },
    });
    return { handled: true, cardId: match.id, attachedTo: match.id };
  }
  // ── No open job it belongs to: a card for him with the file on it, BLOCKED on his word, and one plain question. ──
  const card = await createWorkCardInternal(env, systemIdentity(), {
    title: `Shared by ${partner.firstName}: ${file.title}`.slice(0, 200),
    description: `${partner.fullName} shared a Google ${input.notice.kind} with os@ and it matches none of his open jobs. Porter asked him what to do with it.`,
    owner_type: "AI",
    owner_id: "aie_porter",
    machine_id: 3,
    priority: "NORMAL",
    firm_scope: "west-peek",
    next_action: `Waiting on ${partner.firstName}: what to do with "${file.title}".`,
  });
  await env.WP_OS_DB.prepare("UPDATE work_card SET requested_by_email = ?2 WHERE id = ?1").bind(card.id, partner.email).run();
  await attachDriveFile(env, card.id, file);
  await blockCard(env, { id: card.id, title: card.title, firm_scope: "west-peek" }, {
    reason: "a_question_for_you",
    trying: `"${file.title}", which ${partner.firstName} shared`,
    employee: "Porter",
    who: partner.firstName.toUpperCase() as BlockProvider,
    detail: `${partner.firstName} says what to do with it: add it to one of his jobs, start something new with it, or just file it.`,
  });
  const candidates: Candidate[] = jobs.slice(0, 1).map((j) => ({ cardId: j.id, label: candidateLabel(j), host: (j.property_host ?? "").split(/,\s*/)[0] || null }));
  const id = `icl_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    "INSERT OR IGNORE INTO inbound_clarification (id, message_id, partner_email, subject, eml_key, candidates_json, kind, card_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'SHARE', ?7)",
  )
    .bind(id, input.messageId, partner.email, file.title.slice(0, 300), input.emlKey, JSON.stringify(candidates), card.id)
    .run();
  // #354: the row is the held question (`sent` 0). It is asked by `askHeldShareQuestions` once the grace
  // period has passed with no email of his naming this file; until then nothing is sent to anybody.
  return { handled: true, cardId: card.id, asked: false };
}

/**
 * THE SAME JOIN A PARTNER'S "1" MAKES (`settleShare`), made without asking: the share's question is
 * resolved to the job, its files go onto the job, and the share's own card is cancelled and merged in.
 * Claimed on the clarification row, so it happens once whoever gets there first.
 */
export async function mergeShareIntoJob(env: Env, row: { id: string; message_id: string; card_id: string }, jobCardId: string, by: string): Promise<boolean> {
  const claimed = await env.WP_OS_DB.prepare(
    "UPDATE inbound_clarification SET resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), resolution = 'CARD', resolved_card_id = ?2, resolved_by = ?3 WHERE id = ?1 AND resolved_at IS NULL",
  )
    .bind(row.id, jobCardId, by)
    .run();
  if ((claimed.meta?.changes ?? 0) === 0) return false;
  await moveShareFiles(env, row.card_id, jobCardId);
  await appendEvent(env, {
    eventType: "inbound_email.clarified",
    actorType: "system",
    actorId: by,
    objectType: "inbound_clarification",
    objectId: row.id,
    firmScope: "west-peek",
    payload: { message_id: row.message_id, kind: "SHARE", did: "attached", card_id: jobCardId },
  });
  return true;
}

/** The share card's files onto the job, and the share card closed into it. */
export async function moveShareFiles(env: Env, shareCardId: string, jobCardId: string): Promise<void> {
  const files = (await env.WP_OS_DB.prepare("SELECT file_id, url, title, mime_type, shared_by, shared_at, text, read_error FROM card_drive_file WHERE work_card_id = ?1").bind(shareCardId).all<{ file_id: string; url: string; title: string; mime_type: string | null; shared_by: string | null; shared_at: string | null; text: string | null; read_error: string | null }>()).results ?? [];
  for (const f of files) await attachDriveFile(env, jobCardId, { fileId: f.file_id, url: f.url, title: f.title, mimeType: f.mime_type, sharedBy: f.shared_by, sharedAt: f.shared_at, text: f.text, readError: f.read_error });
  await env.WP_OS_DB.prepare(
    "UPDATE work_card SET state = 'CANCELLED', merged_into_card_id = ?2, next_action = NULL, block_nag_at = NULL, lease_until = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1",
  )
    .bind(shareCardId, jobCardId)
    .run();
}

/**
 * HIS EMAIL NAMES A FILE HE SHARED (#354). Called wherever the door places a partner's message on a
 * card. Every open "Shared by" question of the same partner whose file the message links is joined to
 * that card: held or already sent, it is closed with no email. Returns the share cards merged.
 */
export async function joinSharesNamedIn(env: Env, input: { cardId: string; partnerEmail: string | null; text: string | null }): Promise<string[]> {
  const partner = partnerByEmail(input.partnerEmail);
  const ids = driveIdsIn(input.text);
  if (!partner || ids.length === 0) return [];
  // The job doing the work: the live card this one was handed to (a chief's card closes on hand-off), else the card itself.
  const target = await env.WP_OS_DB.prepare(
    "SELECT id FROM work_card WHERE (id = ?1 OR assigned_from_card_id = ?1) AND state NOT IN ('DONE', 'CANCELLED') AND merged_into_card_id IS NULL ORDER BY (assigned_from_card_id = ?1) DESC, created_at DESC LIMIT 1",
  )
    .bind(input.cardId)
    .first<{ id: string }>();
  if (!target) return [];
  const open = (
    await env.WP_OS_DB.prepare(
      `SELECT ic.id, ic.message_id, ic.card_id, f.file_id FROM inbound_clarification ic JOIN card_drive_file f ON f.work_card_id = ic.card_id
        WHERE ic.kind = 'SHARE' AND ic.resolved_at IS NULL AND ic.partner_email = ?1 AND ic.card_id IS NOT NULL AND ic.card_id != ?2`,
    )
      .bind(partner.email.toLowerCase(), target.id)
      .all<{ id: string; message_id: string; card_id: string; file_id: string }>()
  ).results ?? [];
  const merged: string[] = [];
  for (const row of open) {
    if (!ids.includes(row.file_id) || merged.includes(row.card_id)) continue;
    if (await mergeShareIntoJob(env, row, target.id, "inbound_email")) merged.push(row.card_id);
  }
  return merged;
}

/**
 * THE HELD QUESTION, ASKED WHEN THE GRACE PERIOD ENDS WITH NOTHING (#354). On the sweep. A row is due
 * when it is a share's question, never sent, unresolved, its card still waiting on him, and older than
 * the window. Claimed (`sent` 0 → -1) before the send so it goes once; 1 when it went. Rows older than
 * a day are left to the card's own 24-hour reminder.
 */
export async function askHeldShareQuestions(env: Env, now: Date = new Date()): Promise<number> {
  try {
    const due = new Date(now.getTime() - PARTNER_MATERIAL_GRACE_MINUTES * 60_000).toISOString();
    const stale = new Date(now.getTime() - 24 * 3_600_000).toISOString();
    const rows = (
      await env.WP_OS_DB.prepare(
        `SELECT ic.id, ic.partner_email, ic.candidates_json, ic.card_id, ic.asked_at FROM inbound_clarification ic JOIN work_card c ON c.id = ic.card_id
          WHERE ic.kind = 'SHARE' AND ic.sent = 0 AND ic.resolved_at IS NULL AND ic.asked_at <= ?1 AND ic.asked_at > ?2 AND c.state = 'BLOCKED'
          ORDER BY ic.asked_at LIMIT 5`,
      )
        .bind(due, stale)
        .all<{ id: string; partner_email: string; candidates_json: string; card_id: string; asked_at: string }>()
    ).results ?? [];
    let n = 0;
    for (const row of rows) {
      const claimed = await env.WP_OS_DB.prepare("UPDATE inbound_clarification SET sent = -1 WHERE id = ?1 AND sent = 0 AND resolved_at IS NULL").bind(row.id).run();
      if ((claimed.meta?.changes ?? 0) === 0) continue;
      const partner = partnerByEmail(row.partner_email);
      const file = await env.WP_OS_DB.prepare("SELECT title, url, shared_at FROM card_drive_file WHERE work_card_id = ?1 ORDER BY created_at LIMIT 1").bind(row.card_id).first<{ title: string; url: string; shared_at: string | null }>();
      if (!partner || !file) continue;
      let candidates: Candidate[] = [];
      try {
        candidates = JSON.parse(row.candidates_json) as Candidate[];
      } catch {
        candidates = [];
      }
      const out = await sendPartnerEmail(env, {
        to: partner.email,
        email: shareQuestionEmail({ title: file.title, receivedAt: file.shared_at ?? row.asked_at, url: file.url, candidates }),
        objectType: "inbound_clarification",
        objectId: row.id,
        firmScope: "west-peek",
        actorId: partner.firmUserId,
        events: { sent: "inbound_email.clarification_asked", notSent: "inbound_email.clarification_not_sent" },
      }).catch(() => ({ sent: false }) as { sent: boolean });
      if (out.sent) {
        await env.WP_OS_DB.prepare("UPDATE inbound_clarification SET sent = 1 WHERE id = ?1").bind(row.id).run();
        n++;
      }
    }
    return n;
  } catch (err) {
    console.error("held share questions failed", err);
    return 0;
  }
}
