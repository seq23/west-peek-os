import type { Env } from "../env";
import { partnerByEmail, partnerByFirmUserId } from "../../shared/registry/partners";
import { partnerPracticesBlock } from "../../shared/work/partnerPractices";
import { profileBlockFor } from "./partnerProfile";

/**
 * THE PER-PARTNER CONSTRAINTS REGISTER (R19, 0254; owner, 6 Oct 2026).
 *
 * A partner's standing constraints — "voter emails are private", "test data on preview only", "keys
 * stay server-side", brand words — were kept per REPO (`web_property_registry.constraints_json`), so
 * only Porter on that repo saw them. They are the PARTNER's, so they are kept per partner and read
 * into every job prompt for that partner whatever the kind (`practicesForCard`). A register that
 * grows: a later read never removes a line.
 */

const clean = (s: string) => String(s ?? "").replace(/\s+/g, " ").trim();

/** Add constraints to a partner's register. Only a partner's address has one. Returns how many were new. */
export async function recordPartnerConstraints(env: Env, email: string | null | undefined, constraints: readonly string[], source: string, firmScope = "west-peek"): Promise<number> {
  const partner = partnerByEmail(email);
  if (!partner) return 0;
  let added = 0;
  for (const c of constraints.map(clean).filter((x) => x.length >= 8).slice(0, 40)) {
    const out = await env.WP_OS_DB.prepare("INSERT OR IGNORE INTO partner_constraint (id, partner_email, body, source, firm_scope) VALUES (?1, ?2, ?3, ?4, ?5)")
      .bind(`pcon_${crypto.randomUUID()}`, partner.email.toLowerCase(), c.slice(0, 400), source.slice(0, 120), firmScope)
      .run();
    added += out.meta?.changes ?? 0;
  }
  return added;
}

/** A partner's register, oldest first. */
export async function constraintsForPartner(env: Env, email: string | null | undefined, firmScope = "west-peek"): Promise<string[]> {
  const partner = partnerByEmail(email);
  if (!partner) return [];
  const rows = await env.WP_OS_DB.prepare("SELECT body FROM partner_constraint WHERE firm_scope = ?1 AND partner_email = ?2 ORDER BY created_at ASC LIMIT 40")
    .bind(firmScope, partner.email.toLowerCase())
    .all<{ body: string }>();
  return (rows.results ?? []).map((r) => r.body);
}

/** The partner a card is for: who emailed it, else who made it on the page. */
export async function partnerEmailForCard(env: Env, cardId: string): Promise<string | null> {
  const row = await env.WP_OS_DB.prepare("SELECT requested_by_email, created_by FROM work_card WHERE id = ?1")
    .bind(cardId)
    .first<{ requested_by_email: string | null; created_by: string | null }>();
  return (partnerByEmail(row?.requested_by_email) ?? partnerByFirmUserId(row?.created_by))?.email.toLowerCase() ?? null;
}

/**
 * THE BLOCK EVERY DUTY PROMPT CARRIES for this card: the standing partner practices plus the
 * requesting partner's constraints. Never throws — a prompt without the register is worse than one
 * with "none on record", but a run that dies on it is worse still.
 */
export async function practicesForCard(env: Env, cardId: string, firmScope = "west-peek"): Promise<string> {
  try {
    const email = await partnerEmailForCard(env, cardId);
    // 0255 (rule 4): the requesting partner's living profile rides in the same block, for every kind.
    const profile = await profileBlockFor(env, email).catch(() => "");
    return [partnerPracticesBlock(await constraintsForPartner(env, email, firmScope)), profile].filter(Boolean).join("\n");
  } catch {
    return partnerPracticesBlock([]);
  }
}
