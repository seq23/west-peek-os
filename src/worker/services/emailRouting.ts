import type { Env } from "../env";
import { appendEvent } from "../events";
import type { EmailThreadRow } from "../../shared/email/thread";
import { mailAuthority } from "../../shared/intake/partnerAuthority";
import { addresseeIn, namedSiteHostsIn, parseWebPropertyAsk, type WebProperty } from "../../shared/intake/webPropertyChange";
import { WEB_PROPERTY_CHANGE_KIND } from "../../shared/work/localJobs";
import { partnerByEmail } from "../../shared/registry/partners";
import { textBodyOf } from "../effects/mimeAttachments";
import { loadRegistry } from "./webPropertyRegistry";
import { loadProfile, type PartnerProfile } from "./partnerProfile";
import { sendPartnerEmail } from "./execEmail";

/**
 * WHERE A PARTNER'S NEW EMAIL GOES (9 Oct 2026; owner-approved rules 1a–1e).
 *
 * THE INCIDENT. Scooter's westpeek.ventures spam card was BLOCKED on his preview. His NEW email, "New
 * site build: voting.topbarz.xyz/entry", joined that card as its "answer": the block cleared, the
 * build queued on the wrong site, and the reminder clock was wiped. #233 closed the narrow case (an
 * unregistered host named). This module is the whole rule, for any partner and any burst of emails:
 *
 *   1a  a REPLY to one of our threads steers that thread's card — or the card it was merged into
 *       (`survivorOf`), never a dead one. (emailThread.ts#steerFromReply)
 *   1b  a NEW email is never recorded as the answer to a BLOCKED card. (emailThread.ts, NEW_EMAIL_NOTE_PREFIX)
 *   1c  a NEW email joins an open card only when it is about the same thing — the same site (named, or
 *       called by the name his profile says he uses), else the one open job when he names no site and
 *       does not say it is new, else the open job his words clearly match. Otherwise it is a new card.
 *       No closed list: a host nobody registered is still a site, and a new one opens a new card.
 *   1d  UNCLEAR (several open jobs, no site named, no clear match) → Porter asks him ONCE which job it
 *       is (`askWhichCard`), listing the candidates in plain words. His reply routes it; no reply in
 *       24 hours → a new card (`resolveStaleClarifications`). Never twice about the same email.
 *   1e  an email with nothing in it ("Sent from my iPhone") steers nothing and opens nothing
 *       (`isEmptyMail`, read at the door).
 */

export type RouteAs = { cardId: string } | "NEW";

export interface Candidate {
  cardId: string;
  label: string;
  host: string | null;
}

export type SiteDecision =
  | { kind: "NOT_SITE_MAIL" }
  | { kind: "NEW"; why: string }
  | { kind: "JOIN"; cardId: string; thread: EmailThreadRow; targetRepo: string | null; why: string }
  | { kind: "UNCLEAR"; candidates: Candidate[]; partner: string };

interface OpenCard {
  id: string;
  title: string;
  target_repo: string | null;
  property_host: string | null;
  request_json: string | null;
  description: string | null;
}

/** A new email that says, in so many words, that it is a new job. */
const SAYS_NEW = /\bnew\s+(?:site|website|web\s*site|page|landing\s+page|build|project|app|domain)\b|\bbrand[- ]new\b|\bstart(?:ing)?\s+(?:a\s+)?new\b/i;

const STOP = new Set(
  "about above after again also could does from have here into just like make more need needs only other over please some still than that their them then there these they this those very want what when where which will with would your yours site page porter thanks thank hey hello quick change changes update updates website".split(" "),
);

/** The words that carry a topic: lower case, four letters or more, no filler. Pure. */
export function topicWords(text: string): Set<string> {
  return new Set(
    String(text ?? "")
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, " ")
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4 && !STOP.has(w)),
  );
}

const hostsOf = (h: string | null | undefined) => String(h ?? "").split(/,\s*/).map((x) => x.trim().toLowerCase().replace(/^www\./, "")).filter(Boolean);

/** The hosts the partner's profile says he means by words in this message ("Top Barz" → voting.topbarz.xyz). Pure. */
export function aliasHostsIn(text: string, profile: PartnerProfile | null): string[] {
  if (!profile) return [];
  const t = ` ${String(text ?? "").toLowerCase().replace(/[^a-z0-9.]+/g, " ")} `;
  return [...new Set(profile.aliases.filter((a) => a.words.some((w) => t.includes(` ${w.replace(/[^a-z0-9.]+/g, " ").trim()} `))).map((a) => a.host))];
}

/**
 * A CANDIDATE IN THE PARTNER'S OWN TERMS: what he asked for, in a few words, and the site. The
 * greeting ("Hey Porter!") is never the name of a job. Pure.
 */
export function candidateLabel(card: Pick<OpenCard, "title" | "property_host" | "request_json">): string {
  let ask = "";
  try {
    ask = card.request_json ? String((JSON.parse(card.request_json) as { ask?: string | null }).ask ?? "") : "";
  } catch {
    ask = "";
  }
  const host = hostsOf(card.property_host)[0] ?? null;
  const text = (ask || card.title.replace(/^Change [^:]+:\s*/, "").replace(/^From [^:]+:\s*/, "")).replace(/^["“]|["”]$/g, "");
  const sentences = text
    .replace(/\r/g, "")
    .split(/\n+|(?<=[.!?])\s+/)
    .map((x) => x.replace(/^(?:hey|hi|hello|yo)\b[^a-z0-9]*(?:porter|team|there)?[\s!,.:-]*/i, "").trim())
    .filter((x) => x.length >= 4);
  let name = (sentences[0] ?? card.title).replace(/\s+/g, " ");
  if (name.length > 90) name = `${name.slice(0, 87).replace(/\s+\S*$/, "")}…`;
  return host && !name.toLowerCase().includes(host) ? `${name} (${host})` : name;
}

async function threadFor(env: Env, cardId: string, partner: string): Promise<EmailThreadRow | null> {
  return env.WP_OS_DB.prepare("SELECT * FROM email_thread WHERE object_type = 'work_card' AND object_id = ?1 AND to_address = ?2 ORDER BY created_at DESC LIMIT 1")
    .bind(cardId, partner)
    .first<EmailThreadRow>();
}

/**
 * THE CARD A MERGED (OR SUPERSEDED) CARD LIVES ON IN — rule 1a. Follows `merged_into_card_id` to the
 * end (a cap of eight hops; a loop is cut where it closes). The card itself when nothing points on.
 */
export async function survivorOf(env: Env, cardId: string): Promise<string> {
  let id = cardId;
  const seen = new Set([id]);
  for (let i = 0; i < 8; i++) {
    const row = await env.WP_OS_DB.prepare("SELECT merged_into_card_id FROM work_card WHERE id = ?1").bind(id).first<{ merged_into_card_id: string | null }>();
    const next = row?.merged_into_card_id ?? null;
    if (!next || seen.has(next)) break;
    seen.add(next);
    id = next;
  }
  return id;
}

/**
 * RULE 1c/1d — which open website card (if any) a partner's NEW email is about. Never throws: an
 * unreadable table means "not a follow-up" and the door's ladder opens a card, as it always has.
 */
export async function siteCardDecision(
  env: Env,
  message: { fromHeader: string | null; authenticationResults: string | null; subject: string; raw: string },
  routeAs: RouteAs | null = null,
): Promise<SiteDecision> {
  const authority = mailAuthority({ fromHeader: message.fromHeader, authenticationResults: message.authenticationResults });
  if (!authority.isAssignment || !authority.partnerAddress) return { kind: "NOT_SITE_MAIL" };
  const partner = authority.partnerAddress.toLowerCase();
  try {
    if (routeAs === "NEW") return { kind: "NEW", why: "the partner said it is a new job" };
    if (routeAs) {
      const id = await survivorOf(env, routeAs.cardId);
      const thread = await threadFor(env, id, partner);
      const row = await env.WP_OS_DB.prepare("SELECT target_repo FROM web_property_change WHERE work_card_id = ?1").bind(id).first<{ target_repo: string | null }>();
      return thread ? { kind: "JOIN", cardId: id, thread, targetRepo: row?.target_repo ?? null, why: "the partner said which job" } : { kind: "NEW", why: "the job he named has no conversation to join" };
    }
    const body = textBodyOf(message.raw);
    let registry: WebProperty[] | undefined;
    try {
      registry = await loadRegistry(env);
    } catch {
      registry = undefined;
    }
    const ask = parseWebPropertyAsk(message.subject, body, registry);
    const profile = await loadProfile(env, partner);
    const words = `${message.subject}\n${body}`;
    const aliasHosts = aliasHostsIn(words, profile);
    const toPorter = addresseeIn(body) === "Porter";
    if (!ask && !toPorter && aliasHosts.length === 0) return { kind: "NOT_SITE_MAIL" };

    const open =
      (
        await env.WP_OS_DB.prepare(
          `SELECT c.id, c.title, c.request_json, c.description, w.target_repo, w.property_host
             FROM work_card c JOIN web_property_change w ON w.work_card_id = c.id
            WHERE lower(c.requested_by_email) = ?1 AND c.kind = ?2
              AND c.state NOT IN ('DONE', 'CANCELLED') AND c.merged_into_card_id IS NULL
            ORDER BY c.updated_at DESC`,
        )
          .bind(partner, WEB_PROPERTY_CHANGE_KIND)
          .all<OpenCard>()
      ).results ?? [];
    if (open.length === 0) return { kind: "NEW", why: "no open website job" };

    const join = async (card: OpenCard, why: string): Promise<SiteDecision> => {
      const thread = await threadFor(env, card.id, partner);
      return thread ? { kind: "JOIN", cardId: card.id, thread, targetRepo: card.target_repo, why } : { kind: "NEW", why: "the matching job has no conversation with him to join" };
    };

    // ── A SITE NAMED: by its host (registered or not), or by the name his profile says he uses ──
    const named = new Set([...hostsOf(ask?.property_host), ...namedSiteHostsIn(message.subject, body, registry), ...aliasHosts]);
    if (named.size > 0) {
      const same = open.filter((c) => hostsOf(c.property_host).some((h) => named.has(h)));
      if (same.length > 0) return join(same[0]!, `it names ${[...named].join(", ")}, the site of this open job`);
      return { kind: "NEW", why: `it names ${[...named].join(", ")}, which no open job is for` };
    }
    // ── NO SITE NAMED ──
    if (SAYS_NEW.test(`${message.subject}\n${body}`)) return { kind: "NEW", why: "it says it is a new job" };
    if (open.length === 1) return join(open[0]!, "his one open website job, and the email names no other site");
    const mine = topicWords(words);
    const scored = open
      .map((c) => {
        const aliasWords = (profile?.aliases ?? []).filter((a) => hostsOf(c.property_host).includes(a.host)).flatMap((a) => a.words);
        const theirs = topicWords(`${c.title}\n${candidateLabel(c)}\n${aliasWords.join(" ")}\n${(c.description ?? "").slice(0, 600)}`);
        let score = 0;
        for (const w of mine) if (theirs.has(w)) score++;
        return { c, score };
      })
      .sort((a, b) => b.score - a.score);
    const [top, next] = [scored[0]!, scored[1]];
    if (top.score >= 2 && top.score >= 2 * (next?.score ?? 0)) return join(top.c, `its words match this job (${top.score} shared)`);
    return {
      kind: "UNCLEAR",
      partner,
      candidates: open.slice(0, 4).map((c) => ({ cardId: c.id, label: candidateLabel(c), host: hostsOf(c.property_host)[0] ?? null })),
    };
  } catch {
    return { kind: "NOT_SITE_MAIL" };
  }
}

// ── 1e · EMPTY MAIL ─────────────────────────────────────────────────────────────────────────────

const SIGNATURE = /^(?:sent from my [\w\s]+|get outlook for \w+|sent from (?:yahoo )?mail for \w+|sent via [\w\s]+|sent from \w+ for \w+)\.?$/i;

/** The written words with sign-offs a phone adds ("Sent from my iPhone") taken out. Pure. */
export function withoutSignatures(written: string): string {
  const out: string[] = [];
  for (const line of String(written ?? "").replace(/\r/g, "").split("\n")) {
    if (/^--\s*$/.test(line)) break;
    if (SIGNATURE.test(line.trim())) continue;
    out.push(line);
  }
  return out.join("\n").trim();
}

// ── THE ONE PLAIN SHAPE OF "I CAN'T PLACE THIS" (9 Oct 2026, hostile review of the 13:44Z email) ──
//
// The email Sequoia got about Scooter's shared rules doc: a subject cut mid-word ("…Offici…"), an opening
// that said nothing ("Porter needs something from you before this can go any further"), a false "I have
// nothing in the record about Top Barz", a two-reading essay, and the wrong person asked. Every
// can't-place question is now built here and nowhere else: the subject names what came in, cut only at a
// word; the first line is the fact (when, from whom, what); at most three replies in plain words; the
// original quoted below. It states nothing it did not check — it makes no claim about the record at all.

export const CANT_PLACE_PREFIX = "I got an email I can't place — ";
const SUBJECT_ROOM = 70 - "Porter: ".length;

/** A short subject cut only at a word boundary so `Porter: <lead><short>` fits the 70-character subject. Pure. */
export function shortSubject(subject: string, lead: string): string {
  const s = String(subject ?? "").replace(/^\s*(?:re|fwd?|fw)\s*:\s*/i, "").replace(/^(?:document|spreadsheet|presentation|folder|file|item) shared with you:\s*/i, "").replace(/\s+/g, " ").trim() || "(no subject)";
  const room = SUBJECT_ROOM - lead.length;
  if (s.length <= room) return s;
  const cut = s.slice(0, room - 1);
  const atWord = cut.replace(/\s+\S*$/, "").replace(/[\s,;:—–-]+$/, "");
  return `${(atWord || cut).trim()}…`;
}

/** "8:29 AM CT". Pure. */
export function ctTime(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return `${new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" }).format(d)} CT`;
}

export interface ReplyOption {
  reply: string;
  does: string;
}

export interface PlainQuestion {
  employee: "Porter";
  what: string;
  tldr: string;
  sections: Array<{ label: string; bullets: string[] }>;
  details: string | null;
}

function quoted(original: string): string | null {
  const t = String(original ?? "").replace(/\r/g, "").trim();
  if (!t) return null;
  return ["The message, as it arrived:", ...t.slice(0, 2500).split("\n").map((l) => `> ${l}`)].join("\n");
}

/** The can't-place question. At most three replies; the original quoted below. Pure. */
export function cantPlaceEmail(input: { subject: string; receivedAt: string; fromLabel: string; whatItIs: string; options: readonly ReplyOption[]; original: string; doNotKnow?: string }): PlainQuestion {
  const options = input.options.slice(0, 3);
  return {
    employee: "Porter",
    what: `${CANT_PLACE_PREFIX}${shortSubject(input.subject, CANT_PLACE_PREFIX)}`,
    tldr: `I got the following at ${ctTime(input.receivedAt)} from ${input.fromLabel}: ${input.whatItIs}. ${input.doNotKnow ?? "I don't know what to do with it."}`,
    sections: [
      { label: "Reply with one of these", bullets: options.map((o) => `Reply '${o.reply}' ${o.does}`) },
      { label: "What came in", bullets: [`From ${input.fromLabel}, ${ctTime(input.receivedAt)}: "${String(input.subject ?? "").replace(/\s+/g, " ").trim().slice(0, 160)}"`] },
    ],
    details: quoted(input.original),
  };
}

/** The question about a shared file that matches none of his open jobs (Sequoia's amendment, 9 Oct 2026). Pure. */
export function shareQuestionEmail(input: { title: string; receivedAt: string; url: string; candidates: readonly Candidate[] }): PlainQuestion {
  const lead = "What should I do with ";
  return {
    employee: "Porter",
    what: `${lead}"${shortSubject(input.title, `${lead}""?`)}"?`,
    tldr: `I got "${input.title}" from you at ${ctTime(input.receivedAt)}. What would you like me to do with it?`,
    sections: [
      {
        label: "Reply with one of these",
        bullets: [
          ...input.candidates.slice(0, 1).map((c, i) => `Reply '${i + 1}' to add it to your ${c.label} job`),
          "Reply 'new' to start something new with it",
          "Reply 'file' to just file it",
        ],
      },
      { label: "What came in", bullets: [`"${input.title}" — ${input.url}`] },
    ],
    details: null,
  };
}

// ── 1d · THE ONE CLARIFYING QUESTION ─────────────────────────────────────────────────────────────

export interface ClarificationRow {
  id: string;
  message_id: string;
  partner_email: string;
  subject: string | null;
  eml_key: string | null;
  raw_text: string | null;
  candidates_json: string;
  asked_at: string;
  resolved_at: string | null;
  kind?: string | null;
  card_id?: string | null;
}

/**
 * Ask the partner which open job a new email is for — ONCE per message (UNIQUE message_id). Returns
 * true when the question exists (asked now or before); the door then opens nothing for the email.
 */
export async function askWhichCard(
  env: Env,
  input: { messageId: string; partner: string; subject: string; written: string; emlKey: string | null; raw: string; candidates: Candidate[] },
): Promise<{ asked: boolean; already: boolean; id: string }> {
  const existing = await env.WP_OS_DB.prepare("SELECT id FROM inbound_clarification WHERE message_id = ?1").bind(input.messageId).first<{ id: string }>();
  if (existing) return { asked: true, already: true, id: existing.id };
  const id = `icl_${crypto.randomUUID()}`;
  const ins = await env.WP_OS_DB.prepare(
    `INSERT OR IGNORE INTO inbound_clarification (id, message_id, partner_email, subject, eml_key, raw_text, candidates_json)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  )
    .bind(id, input.messageId, input.partner, input.subject.slice(0, 300), input.emlKey, input.emlKey ? null : input.raw.slice(0, 200_000), JSON.stringify(input.candidates.slice(0, 2)))
    .run();
  if ((ins.meta?.changes ?? 0) === 0) {
    const row = await env.WP_OS_DB.prepare("SELECT id FROM inbound_clarification WHERE message_id = ?1").bind(input.messageId).first<{ id: string }>();
    return { asked: true, already: true, id: row?.id ?? id };
  }
  const partner = partnerByEmail(input.partner);
  const said = input.written.replace(/\s+/g, " ").trim();
  const shown = input.candidates.slice(0, 2);
  const out = await sendPartnerEmail(env, {
    to: input.partner,
    email: cantPlaceEmail({
      subject: input.subject,
      receivedAt: new Date().toISOString(),
      fromLabel: "you",
      whatItIs: `"${input.subject.trim() || said.slice(0, 60) || "an email"}"`,
      doNotKnow: "I don't know which of your jobs it is for.",
      options: [...shown.map((c, i) => ({ reply: String(i + 1), does: `to add it to your ${c.label} job` })), { reply: "new", does: "to start it as a new job" }],
      original: input.written,
    }),
    objectType: "inbound_clarification",
    objectId: id,
    firmScope: "west-peek",
    actorId: partner?.firmUserId ?? "inbound_email",
    events: { sent: "inbound_email.clarification_asked", notSent: "inbound_email.clarification_not_sent" },
  }).catch(() => ({ sent: false }) as { sent: boolean });
  await env.WP_OS_DB.prepare("UPDATE inbound_clarification SET sent = ?2 WHERE id = ?1").bind(id, out.sent ? 1 : 0).run();
  return { asked: true, already: false, id };
}

/** Read a partner's answer to the clarifying question. Pure over the row's candidates. */
export function readClarificationAnswer(written: string, candidates: readonly Candidate[]): RouteAs | null {
  const first = withoutSignatures(written).split("\n").find((l) => l.trim()) ?? "";
  const t = first.trim().toLowerCase();
  const n = /^#?\s*(\d)\b/.exec(t);
  if (n) {
    const c = candidates[Number(n[1]) - 1];
    return c ? { cardId: c.cardId } : null;
  }
  if (/^(?:it'?s\s+)?(?:a\s+)?new\b|\bnew (?:one|job|card|request|thing)\b|\bneither\b|\bnone\b/.test(t)) return "NEW";
  const hostHit = candidates.filter((c) => c.host && t.includes(c.host));
  if (hostHit.length === 1) return { cardId: hostHit[0]!.cardId };
  const mine = topicWords(t);
  const scored = candidates.map((c) => ({ c, s: [...topicWords(c.label)].filter((w) => mine.has(w)).length })).sort((a, b) => b.s - a.s);
  if (scored[0] && scored[0].s >= 1 && (scored[1]?.s ?? 0) < scored[0].s) return { cardId: scored[0].c.cardId };
  return null;
}

async function settle(env: Env, row: ClarificationRow, routeAs: RouteAs, resolution: "CARD" | "NEW" | "TIMED_OUT", by: string): Promise<boolean> {
  const claimed = await env.WP_OS_DB.prepare(
    `UPDATE inbound_clarification SET resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), resolution = ?2, resolved_card_id = ?3, resolved_by = ?4
      WHERE id = ?1 AND resolved_at IS NULL`,
  )
    .bind(row.id, resolution, routeAs === "NEW" ? null : routeAs.cardId, by)
    .run();
  if ((claimed.meta?.changes ?? 0) === 0) return false;
  const { rerouteStoredMessage } = await import("../effects/inboundEmail");
  await rerouteStoredMessage(env, { emlKey: row.eml_key, rawText: row.raw_text, routeAs });
  await appendEvent(env, {
    eventType: "inbound_email.clarified",
    actorType: "system",
    actorId: by,
    objectType: "inbound_clarification",
    objectId: row.id,
    firmScope: "west-peek",
    payload: { message_id: row.message_id, resolution, card_id: routeAs === "NEW" ? null : routeAs.cardId },
  });
  return true;
}

/**
 * The partner answered the question. A number, a site, "new" — read and routed. An answer that names
 * nothing readable is a new job (the same default as no answer), never a second question.
 */
export async function answerClarification(env: Env, clarificationId: string, written: string, by: string): Promise<{ routed: boolean; routeAs: RouteAs | null }> {
  const row = await env.WP_OS_DB.prepare("SELECT * FROM inbound_clarification WHERE id = ?1").bind(clarificationId).first<ClarificationRow>();
  if (!row || row.resolved_at) return { routed: false, routeAs: null };
  let candidates: Candidate[] = [];
  try {
    candidates = JSON.parse(row.candidates_json) as Candidate[];
  } catch {
    candidates = [];
  }
  if (row.kind === "SHARE" && row.card_id) {
    const { settleShare } = await import("./driveShareAnswers");
    return settleShare(env, row, written, candidates, by);
  }
  const read = readClarificationAnswer(written, candidates) ?? "NEW";
  const routed = await settle(env, row, read, read === "NEW" ? "NEW" : "CARD", by);
  return { routed, routeAs: read };
}

/** No answer in 24 hours → a new card (the sweep's tick). Never throws. */
export async function resolveStaleClarifications(env: Env, now: Date = new Date()): Promise<number> {
  try {
    const cutoff = new Date(now.getTime() - 24 * 3_600_000).toISOString();
    const rows = (await env.WP_OS_DB.prepare("SELECT * FROM inbound_clarification WHERE resolved_at IS NULL AND asked_at < ?1 AND kind = 'EMAIL' ORDER BY asked_at LIMIT 5").bind(cutoff).all<ClarificationRow>()).results ?? [];
    let n = 0;
    for (const r of rows) if (await settle(env, r, "NEW", "TIMED_OUT", "work_sweep")) n++;
    return n;
  } catch (err) {
    console.error("clarification timeout sweep failed", err);
    return 0;
  }
}

/**
 * THE QUESTION A ROUTING CARD ("Unclear email: …") ASKS, built from the stored message — never from the
 * model's reasoning. Options name a partner's open job only when his profile's words for a site appear in
 * the message and he has an open job for that site; otherwise "new" and "drop". Null when the message
 * cannot be found (the generic question stands).
 */
export async function unclearEmailQuestion(env: Env, cardId: string): Promise<PlainQuestion | null> {
  const msg = await env.WP_OS_DB.prepare("SELECT subject, from_address, received_at, r2_key FROM inbound_message WHERE work_card_id = ?1 ORDER BY received_at LIMIT 1")
    .bind(cardId)
    .first<{ subject: string | null; from_address: string; received_at: string; r2_key: string }>();
  if (!msg) return null;
  let raw = "";
  try {
    raw = env.WP_OS_DOCUMENTS ? ((await (await env.WP_OS_DOCUMENTS.get(msg.r2_key))?.text()) ?? "") : "";
  } catch {
    raw = "";
  }
  const body = raw ? textBodyOf(raw) : "";
  const subject = msg.subject ?? "";
  const { driveShareNotice } = await import("../../shared/intake/driveShare");
  const { headersOfRaw } = await import("../effects/inboundEmail");
  const h = raw ? headersOfRaw(raw) : new Headers();
  const share = driveShareNotice({ from: h.get("from") ?? msg.from_address, replyTo: h.get("reply-to"), authenticationResults: h.get("authentication-results"), subject, body });
  const options: ReplyOption[] = [];
  for (const p of (await import("../../shared/registry/partners")).PARTNERS) {
    const profile = await loadProfile(env, p.email);
    const hosts = aliasHostsIn(`${subject}\n${share?.title ?? ""}\n${body.slice(0, 4000)}`, profile);
    if (!hosts.length) continue;
    const job = await env.WP_OS_DB.prepare(
      `SELECT c.id, c.title, c.request_json, w.property_host FROM work_card c JOIN web_property_change w ON w.work_card_id = c.id
        WHERE lower(c.requested_by_email) = ?1 AND c.state NOT IN ('DONE','CANCELLED') AND c.merged_into_card_id IS NULL ORDER BY c.updated_at DESC`,
    )
      .bind(p.email)
      .all<OpenCard>();
    const hit = (job.results ?? []).find((c) => hostsOf(c.property_host).some((x) => hosts.includes(x)));
    if (!hit) continue;
    const word = profile?.aliases.find((a) => hosts.includes(a.host))?.words[0] ?? hosts[0]!;
    options.push({ reply: word, does: `to add it to ${p.firstName}'s ${candidateLabel(hit)} job` });
    break;
  }
  options.push({ reply: "new", does: "to start it as a new job" }, { reply: "drop", does: "to file it and do nothing" });
  return cantPlaceEmail({
    subject,
    receivedAt: msg.received_at,
    fromLabel: share ? (share.sharer ? `${share.sharer} (a Google share notice)` : "Google share notice, sharer unknown") : msg.from_address,
    whatItIs: share ? `a shared Google ${share.kind}, "${share.title}"` : `"${subject.trim() || "(no subject)"}"`,
    options,
    original: body || subject,
  });
}
