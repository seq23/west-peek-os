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
        `SELECT c.id, c.title, c.request_json, w.property_host FROM work_card c LEFT JOIN web_property_change w ON w.work_card_id = c.id
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
  const match = matchShareToJob(file.title, jobs, aliasHostsIn(file.title, profile));
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
  const ins = await env.WP_OS_DB.prepare(
    "INSERT OR IGNORE INTO inbound_clarification (id, message_id, partner_email, subject, eml_key, candidates_json, kind, card_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'SHARE', ?7)",
  )
    .bind(id, input.messageId, partner.email, file.title.slice(0, 300), input.emlKey, JSON.stringify(candidates), card.id)
    .run();
  let asked = false;
  if ((ins.meta?.changes ?? 0) > 0) {
    const out = await sendPartnerEmail(env, {
      to: partner.email,
      email: shareQuestionEmail({ title: file.title, receivedAt: input.receivedAt, url: file.url, candidates }),
      objectType: "inbound_clarification",
      objectId: id,
      firmScope: "west-peek",
      actorId: partner.firmUserId,
      events: { sent: "inbound_email.clarification_asked", notSent: "inbound_email.clarification_not_sent" },
    }).catch(() => ({ sent: false }) as { sent: boolean });
    asked = out.sent;
    await env.WP_OS_DB.prepare("UPDATE inbound_clarification SET sent = ?2 WHERE id = ?1").bind(id, asked ? 1 : 0).run();
  }
  return { handled: true, cardId: card.id, asked };
}
