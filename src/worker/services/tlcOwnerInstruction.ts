import type { Env } from "../env";
import { appendEvent } from "../events";
import { textBodyOf } from "../effects/mimeAttachments";
import { TLC_OWNER } from "../../shared/tlc/learningClub";
import { herNoteOf, theirNewText, BRAND_REPLY_REF_RE } from "../../shared/tlc/brandReply";
import { brandKey } from "../../shared/tlc/mustPitch";
import { ownerContactInstructions, type OwnerContactInstruction } from "../../shared/tlc/ownerInstruction";
import { logMustPitch, OWNER_SUPPLIED_SOURCE, queueDeal, type WayInRow } from "./tlcMustPitch";

/*
 * HER EMAILED INSTRUCTION REACHES THE BRAND'S DEAL (owner, 29 Oct 2026; found 31 Oct 2026).
 *
 * THE INCIDENT. She replied to "Wynn: 1 brand reply to approve · TLR-…" (Pinecone's answer) with research and, inside
 * it, "pitch this person at <Brand> - <address>" and how to frame that pitch. The only door that read the reply was the
 * brand-reply approval (tlcBrandReply.ts#handleBrandReplyApproval): one reply in the email, so ALL of her note became
 * her "change" to Pinecone's answer, and `learnRules` stored the address sentence as a standing rule for every brand.
 * Nothing read a contact out of her mail, so the must-pitch brand stayed at "Needs a way in" with no address.
 *
 * THE RULE. Every authenticated email from her to the OS, on any thread and whatever else it does, is read once more
 * here, each daily drip pass, before the drip drafts: every address she tells Wynn to use for a brand goes onto that
 * brand's way-in item as her contact (no page check: she supplied it), the brand joins her must-pitch list for the
 * club if it was not on it, and the deal is queued (or, not yet written to, re-pointed) with her angle. Email 1 is then
 * drafted to her angle and joins her approval email like every other; nothing is sent without her approval.
 *
 * WHICH CLUB. The months she names (by month or the club's topic); else the club of the thread she replied on (a
 * TLR-… reply's deal); else every open month the brand is on her list for; else the nearest open club.
 */

export const INSTRUCTION_LOOKBACK_DAYS = 14;
export const SUPPLIED_BY_EMAIL = "Sequoia (by email)";

interface InboundRow { id: string; message_id: string; r2_key: string | null; from_address: string; subject: string; received_at: string; mail_authority_json: string | null }
interface OpenEvent { id: string; month: string; topic: string | null }

/** Her words in a stored message: the new text only, her signature off. */
export function herWordsIn(raw: string): string {
  return herNoteOf(theirNewText(textBodyOf(raw)), TLC_OWNER.name);
}

/** Is this stored message authenticated mail from her? */
function isHers(row: InboundRow): boolean {
  if (row.from_address.trim().toLowerCase() !== TLC_OWNER.email.toLowerCase()) return false;
  try {
    const a = JSON.parse(row.mail_authority_json ?? "{}") as { passed?: boolean; partner?: string };
    return a.passed === true && String(a.partner ?? "").toLowerCase() === TLC_OWNER.email.toLowerCase();
  } catch {
    return false;
  }
}

/** The club month of the thread she replied on, when it is a brand-reply approval (TLR-…). */
async function threadMonth(env: Env, subject: string, words: string): Promise<string | null> {
  const ref = BRAND_REPLY_REF_RE.exec(subject)?.[0] ?? BRAND_REPLY_REF_RE.exec(words)?.[0] ?? null;
  if (!ref) return null;
  const notice = await env.WP_OS_DB.prepare("SELECT reply_ids_json FROM tlc_brand_reply_notice WHERE ref = ?1").bind(ref).first<{ reply_ids_json: string }>();
  const first = (() => { try { return (JSON.parse(notice?.reply_ids_json ?? "[]") as string[])[0] ?? null; } catch { return null; } })();
  if (!first) return null;
  const row = await env.WP_OS_DB.prepare("SELECT e.month FROM tlc_brand_reply r JOIN tlc_deal d ON d.id = r.deal_id JOIN tlc_event e ON e.id = d.event_id WHERE r.id = ?1").bind(first).first<{ month: string }>();
  return row?.month ?? null;
}

/**
 * APPLY ONE CONTACT SHE GAVE BY EMAIL. Returns what happened, in words. Idempotent per deal: an existing deal not yet
 * written to is re-pointed to her address; one already written to keeps its thread and only gains her angle.
 */
export async function applyOwnerContact(
  env: Env,
  c: OwnerContactInstruction & { months: string[] },
  events: readonly OpenEvent[],
  now: Date,
  firmScope = "west-peek",
): Promise<string> {
  const at = now.toISOString();
  const evs = events.filter((e) => c.months.includes(e.month));
  if (evs.length === 0) return `${c.brand}: no open club for ${c.months.join(", ")}`;
  const months = evs.map((e) => e.month).sort();
  // On her list for those months (her email asked for this brand, so it is a must-pitch for that club).
  for (const ev of evs) {
    const on = await env.WP_OS_DB.prepare("SELECT 1 FROM tlc_must_pitch WHERE firm_scope = ?1 AND month = ?2 AND lower(brand) = ?3 AND removed_at IS NULL").bind(firmScope, ev.month, c.brandKey).first();
    if (on) continue;
    await env.WP_OS_DB.prepare("INSERT INTO tlc_must_pitch (id, month, brand, reason, added_by, added_at, firm_scope) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
      .bind(`tmp_${crypto.randomUUID()}`, ev.month, c.brand, "You asked by email for this contact to be pitched.", SUPPLIED_BY_EMAIL, at, firmScope).run();
    await logMustPitch(env, { brand: c.brand, month: ev.month, action: "ADDED", by: SUPPLIED_BY_EMAIL, at, detail: "from your email", firmScope });
  }
  // The way-in item carries her contact, for those months only.
  const way = await env.WP_OS_DB.prepare("SELECT * FROM tlc_way_in WHERE firm_scope = ?1 AND brand_key = ?2").bind(firmScope, c.brandKey).first<WayInRow>();
  const note = c.angle ? c.angle.slice(0, 600) : null;
  if (way) {
    await env.WP_OS_DB.prepare(
      "UPDATE tlc_way_in SET state = 'CONTACT_ADDED', contact_name = ?3, contact_email = ?4, note = ?5, supplied_by = ?6, supplied_at = ?7, changed_at = ?7, contact_months_json = ?8 WHERE firm_scope = ?1 AND brand_key = ?2",
    ).bind(firmScope, c.brandKey, c.contactName, c.email, note, SUPPLIED_BY_EMAIL, at, JSON.stringify(months)).run();
  } else {
    await env.WP_OS_DB.prepare(
      "INSERT INTO tlc_way_in (brand_key, brand, firm_scope, state, months_json, pages_checked_json, why, opened_at, checked_at, changed_at, contact_name, contact_email, note, supplied_by, supplied_at, contact_months_json) VALUES (?1, ?2, ?3, 'CONTACT_ADDED', ?4, '[]', NULL, ?5, ?5, ?5, ?6, ?7, ?8, ?9, ?5, ?4)",
    ).bind(c.brandKey, c.brand, firmScope, JSON.stringify(months), at, c.contactName, c.email, note, SUPPLIED_BY_EMAIL).run();
  }
  await logMustPitch(env, { brand: c.brand, month: months.join(","), action: "CONTACT_ADDED", by: SUPPLIED_BY_EMAIL, at, detail: `${c.email} from your email`, firmScope });
  const source = `${OWNER_SUPPLIED_SOURCE}:${SUPPLIED_BY_EMAIL}`;
  const done: string[] = [];
  for (const ev of evs) {
    const deal = await env.WP_OS_DB.prepare("SELECT id, first_sent_at FROM tlc_deal WHERE event_id = ?1 AND lower(brand) = ?2").bind(ev.id, c.brandKey).first<{ id: string; first_sent_at: string | null }>();
    if (deal && !deal.first_sent_at) {
      await env.WP_OS_DB.prepare("UPDATE tlc_deal SET contact_email = ?2, contact_name = COALESCE(?3, contact_name), contact_source_url = ?4, owner_angle = ?5, updated_at = ?6 WHERE id = ?1")
        .bind(deal.id, c.email, c.contactName, source, c.angle, at).run();
      done.push(`${ev.month} re-pointed`);
    } else if (deal) {
      await env.WP_OS_DB.prepare("UPDATE tlc_deal SET owner_angle = ?2, updated_at = ?3 WHERE id = ?1").bind(deal.id, c.angle, at).run();
      done.push(`${ev.month} already written to; your angle noted`);
    } else if (await queueDeal(env, { eventId: ev.id, brand: c.brand, category: null, contactName: c.contactName, contactEmail: c.email, contactSourceUrl: source, whyFit: "On your must-pitch list; you gave the contact by email.", firmScope, ownerAngle: c.angle }, now)) {
      await logMustPitch(env, { brand: c.brand, month: ev.month, action: "QUEUED", by: SUPPLIED_BY_EMAIL, at, detail: "with the contact you emailed", firmScope });
      done.push(`${ev.month} queued`);
    }
  }
  return `${c.brand} <${c.email}>: ${done.join("; ") || "nothing to change"}`;
}

/**
 * EACH PASS: her authenticated emails of the last INSTRUCTION_LOOKBACK_DAYS not read yet are read for brand contacts,
 * and each is applied. A message is read once (tlc_owner_instruction). Returns one line per contact applied.
 */
export async function applyOwnerEmailInstructions(env: Env, now: Date, firmScope = "west-peek", readRaw: (key: string) => Promise<string | null> = defaultReadRaw(env)): Promise<string[]> {
  const since = new Date(now.getTime() - INSTRUCTION_LOOKBACK_DAYS * 86_400_000).toISOString();
  const rows = ((await env.WP_OS_DB.prepare(
    `SELECT id, message_id, r2_key, from_address, subject, received_at, mail_authority_json FROM inbound_message m
      WHERE m.firm_scope = ?1 AND m.received_at >= ?2 AND lower(m.from_address) = ?3 AND m.r2_key IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM tlc_owner_instruction i WHERE i.message_id = m.message_id)
      ORDER BY m.received_at`,
  ).bind(firmScope, since, TLC_OWNER.email.toLowerCase()).all<InboundRow>()).results ?? []).filter(isHers);
  if (rows.length === 0) return [];
  const events = (await env.WP_OS_DB.prepare("SELECT id, month, topic FROM tlc_event WHERE firm_scope = ?1 AND status NOT IN ('DONE','CANCELLED') ORDER BY month").bind(firmScope).all<OpenEvent>()).results ?? [];
  const known = [
    ...((await env.WP_OS_DB.prepare("SELECT DISTINCT brand FROM tlc_must_pitch WHERE firm_scope = ?1 AND removed_at IS NULL").bind(firmScope).all<{ brand: string }>()).results ?? []).map((r) => r.brand),
    ...((await env.WP_OS_DB.prepare("SELECT DISTINCT brand FROM tlc_way_in WHERE firm_scope = ?1").bind(firmScope).all<{ brand: string }>()).results ?? []).map((r) => r.brand),
  ];
  const lines: string[] = [];
  const at = now.toISOString();
  for (const row of rows) {
    const raw = await readRaw(row.r2_key!);
    if (raw === null) continue; // not readable yet: tried again next pass
    const words = herWordsIn(raw);
    const found = ownerContactInstructions(words, known, events);
    if (found.length === 0) {
      await env.WP_OS_DB.prepare("INSERT OR IGNORE INTO tlc_owner_instruction (message_id, brand_key, contact_email, months_json, result, applied_at, firm_scope) VALUES (?1, '', NULL, NULL, 'NONE', ?2, ?3)").bind(row.message_id, at, firmScope).run();
      continue;
    }
    const fromThread = await threadMonth(env, row.subject, words);
    for (const c of found) {
      const listed = ((await env.WP_OS_DB.prepare("SELECT month FROM tlc_must_pitch WHERE firm_scope = ?1 AND lower(brand) = ?2 AND removed_at IS NULL").bind(firmScope, c.brandKey).all<{ month: string }>()).results ?? [])
        .map((r) => r.month).filter((m) => events.some((e) => e.month === m));
      const months = c.months ?? (fromThread && events.some((e) => e.month === fromThread) ? [fromThread] : listed.length ? listed : events.slice(0, 1).map((e) => e.month));
      const line = await applyOwnerContact(env, { ...c, months }, events, now, firmScope);
      await env.WP_OS_DB.prepare("INSERT OR IGNORE INTO tlc_owner_instruction (message_id, brand_key, contact_email, months_json, result, applied_at, firm_scope) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
        .bind(row.message_id, brandKey(c.brand), c.email, JSON.stringify(months), line.slice(0, 500), at, firmScope).run();
      lines.push(line);
    }
  }
  if (lines.length) {
    await appendEvent(env, { eventType: "tlc.owner_email_contact", actorType: "ai_employee", actorId: "aie_wynn", objectType: "tlc_way_in", objectId: lines.join(" | ").slice(0, 200), firmScope, payload: { lines } });
  }
  return lines;
}

function defaultReadRaw(env: Env): (key: string) => Promise<string | null> {
  return async (key) => {
    const obj = env.WP_OS_DOCUMENTS ? await env.WP_OS_DOCUMENTS.get(key) : null;
    return obj ? await obj.text() : null;
  };
}

// ── Email 1 to her angle ────────────────────────────────────────────────────────────────────────

/** Writes one or two brand-facing sentences from her angle (a model on the firm's own lane), or null. */
export type AngleWriter = (env: Env, input: { brand: string; topic: string; angle: string }) => Promise<string | null>;

export const defaultAngleWriter: AngleWriter = async (env, input) => {
  const { runAi } = await import("../ai/runAi");
  const prompt = [
    "You are Wynn, who writes The Learning Club's partnership emails for Sequoia Taylor of West Peek. Below is her private note on how to pitch this brand.",
    `Write ONE or TWO plain sentences for the brand, in "we" voice, saying what the club gives ${input.brand}, following her framing. Under 60 words.`,
    "Rules: no money, prices, budgets or numbers of dollars; never say guaranteed, forcing, mandatory, exclusive or required; say the members build on the product, never that they are made to; no call or meeting; no logo; no names of people.",
    `Club topic: ${input.topic}`,
    `Her note: ${input.angle}`,
    'Return ONLY JSON: {"line":""}',
  ].join("\n");
  const { run } = await runAi(env, {
    purpose: "The Learning Club: her angle for a brand's first email",
    actor: { type: "AI", aiEmployeeId: "aie_wynn", roles: [], firmScopes: ["west-peek"] },
    inputs: [prompt],
    sensitivity: "PUBLIC",
    budgetContext: { requiresSearch: false, expectedOutputTokens: 200 },
    routing: { category: "INTELLIGENCE" },
  } as never);
  if (run.status !== "COMPLETED" || !run.output_text) return null;
  try {
    const m = /\{[\s\S]*\}/.exec(run.output_text);
    const line = String((JSON.parse(m?.[0] ?? "{}") as { line?: unknown }).line ?? "").trim();
    return line || null;
  } catch {
    return null;
  }
};

/**
 * EMAIL 1 FOR A DEAL SHE GAVE AN ANGLE FOR: her brand rules' opening, the club, and her angle in brand-facing words.
 * A line that breaks a rule (money, guarantee words, a call, a logo) is left out, never sent to her as is: the email
 * still opens with West Peek, and her approval email shows her angle beside it.
 */
export async function ownerAngleMail(env: Env, deal: { brand: string; contact_name: string | null; owner_angle: string }, ev: { month: string; topic: string }, writer: AngleWriter = defaultAngleWriter): Promise<{ subject: string; text: string; angleUsed: boolean }> {
  const { ownerAngleFirstEmail, angleLineProblems } = await import("../../shared/tlc/ownerInstruction");
  const { brandDisplayName } = await import("../../shared/tlc/learningClub");
  const brand = brandDisplayName(deal.brand);
  const line = await writer(env, { brand, topic: ev.topic, angle: deal.owner_angle }).catch(() => null);
  const ok = line !== null && angleLineProblems(line).length === 0;
  const mail = ownerAngleFirstEmail({ brand, contactName: deal.contact_name, topic: ev.topic, month: ev.month, angleLine: ok ? line : null });
  return { ...mail, angleUsed: ok };
}
