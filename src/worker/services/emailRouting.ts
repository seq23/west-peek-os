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
    .bind(id, input.messageId, input.partner, input.subject.slice(0, 300), input.emlKey, input.emlKey ? null : input.raw.slice(0, 200_000), JSON.stringify(input.candidates))
    .run();
  if ((ins.meta?.changes ?? 0) === 0) {
    const row = await env.WP_OS_DB.prepare("SELECT id FROM inbound_clarification WHERE message_id = ?1").bind(input.messageId).first<{ id: string }>();
    return { asked: true, already: true, id: row?.id ?? id };
  }
  const partner = partnerByEmail(input.partner);
  const said = input.written.replace(/\s+/g, " ").trim();
  const what = input.subject.trim() || said.slice(0, 40) || "your email";
  const out = await sendPartnerEmail(env, {
    to: input.partner,
    email: {
      employee: "Porter",
      what: `Which job is "${what.slice(0, 30)}" for?`.slice(0, 60),
      tldr: `Is "${what.slice(0, 60)}" for one of your open jobs, or a new one? Reply with the number, or "new".`,
      sections: [
        { label: "You sent", bullets: [`"${what.slice(0, 80)}"${said ? ` — ${said.slice(0, 120)}` : ""}`] },
        { label: "Which job is it?", bullets: [...input.candidates.slice(0, 4).map((c, i) => `${i + 1} — ${c.label}`), `new — a new job`] },
        { label: "If you do not reply", bullets: ["By this time tomorrow I start it as a new job. I will not ask again."] },
      ],
      details: null,
    },
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
  const read = readClarificationAnswer(written, candidates) ?? "NEW";
  const routed = await settle(env, row, read, read === "NEW" ? "NEW" : "CARD", by);
  return { routed, routeAs: read };
}

/** No answer in 24 hours → a new card (the sweep's tick). Never throws. */
export async function resolveStaleClarifications(env: Env, now: Date = new Date()): Promise<number> {
  try {
    const cutoff = new Date(now.getTime() - 24 * 3_600_000).toISOString();
    const rows = (await env.WP_OS_DB.prepare("SELECT * FROM inbound_clarification WHERE resolved_at IS NULL AND asked_at < ?1 ORDER BY asked_at LIMIT 5").bind(cutoff).all<ClarificationRow>()).results ?? [];
    let n = 0;
    for (const r of rows) if (await settle(env, r, "NEW", "TIMED_OUT", "work_sweep")) n++;
    return n;
  } catch (err) {
    console.error("clarification timeout sweep failed", err);
    return 0;
  }
}
