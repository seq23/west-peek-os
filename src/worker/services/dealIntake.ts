import type { Env } from "../env";
import { appendEvent } from "../events";
import type { Actor } from "./authorize";
import { createOpportunity } from "./investment";

/**
 * A company arriving by email enters the FUNNEL, not the scratchpad.
 *
 * Operator correction, 21 Aug 2026: "#wpdeck should skip capture and an ai employee who deals w/the
 * deal flow should enter it into the funnel. and #wpdealflow should ultimately also be handled by
 * that employee... capture page is for things we manually want to capture. the top of the funnel is
 * the deal flow tab."
 *
 * The first version filed every triggered email as a capture. That was wrong, and the reason is
 * worth keeping: Capture is a person's own scratchpad for things THEY chose to note down. Machine
 * intake landing there turns a deliberate list into an inbox, and the operator then has to sort the
 * firm's mail out of their own notes. A company belongs at the top of the funnel, where the analyst
 * already works.
 *
 * WYATT DOES IT, and he is the seat that already owns this — "Analyst & Scout", whose bio reads
 * "Finds companies and keeps what the firm knows about them straight." The employee is named on
 * every record so the funnel says where a deal came from and who put it there.
 *
 * MATCH FIRST, ALWAYS. `#wpdeck` is explicitly for "a new company or fill in blanks for a company
 * already added with info missing", and `#wpdealflow` has the same duplicate risk: a follow-up
 * email about a company already on the board must not build a second row for it. So every arrival
 * looks for an existing company before it creates one, and an existing one is ENRICHED — only where
 * a field is actually empty. A later email never overwrites something a person typed.
 *
 * IT PROPOSES. The opportunity is created at NEW, the first stage of the spine, and nothing about
 * arriving by email advances it. A hashtag is a public word — it may route, never authorise.
 */

/** The seat that owns incoming companies. Named, not anonymous, so the funnel records who filed it. */
export const DEAL_INTAKE_EMPLOYEE = "Wyatt";

export interface EmailDeal {
  company: string;
  sector?: string | null;
  one_liner?: string | null;
  website?: string | null;
  /** Who sent it. Provenance is the only thing that makes an unauthenticated arrival reviewable. */
  from: string;
  /** True when the message said the substance is in an attachment. */
  isDeck: boolean;
  raw: string;
}

export interface IntakeResult {
  outcome: "OPENED" | "ENRICHED" | "ALREADY_OPEN";
  company_id: string;
  opportunity_id: string | null;
  detail: string;
}

/**
 * Read a company out of a message.
 *
 * Deliberately conservative: an explicit `Company:` line, or the subject with the trigger stripped.
 * Guessing a company name out of prose produces confident wrong records, and a wrong company at the
 * top of the funnel is worse than no company — somebody has to notice it is wrong before they can
 * delete it.
 */
export function dealFromMessage(subject: string, body: string, from: string, isDeck: boolean): EmailDeal | null {
  const field = (key: string): string | null => {
    const m = new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`, "im").exec(body);
    return m ? m[1]!.trim() : null;
  };

  const named = field("company");
  const fromSubject = subject
    .replace(/#wp[a-z]+/gi, "")
    .replace(/^\s*(re|fwd)\s*:\s*/i, "")
    .trim();

  const company = named ?? (fromSubject.length >= 2 ? fromSubject : null);
  if (!company) return null;

  return {
    company,
    sector: field("sector"),
    one_liner: field("one liner") ?? field("one-liner") ?? field("what they do"),
    website: field("website") ?? field("url"),
    from,
    isDeck,
    raw: body,
  };
}

/** Case- and punctuation-insensitive, because "Acme, Inc." and "Acme Inc" are one company. */
function normalise(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\b(inc|llc|ltd|corp|co)\b/g, "").trim();
}

export async function intakeDealFromEmail(env: Env, deal: EmailDeal): Promise<IntakeResult> {
  const firmScope = "west-peek";

  // Wyatt files it. SYSTEM rather than a person because nobody at the firm typed this in, and
  // attributing it to whoever reads it first would put a name on the record that did not do it.
  const actor: Actor = { type: "SYSTEM", roles: [], firmScopes: [firmScope] };

  const wanted = normalise(deal.company);
  const candidates = (
    await env.WP_OS_DB.prepare("SELECT id, canonical_name, sector, one_liner, website FROM canonical_company")
      .all<{ id: string; canonical_name: string; sector: string | null; one_liner: string | null; website: string | null }>()
  ).results ?? [];

  const existing = candidates.find((c) => normalise(c.canonical_name) === wanted);

  if (existing) {
    // ENRICH, and only where the field is genuinely empty. A later email must never overwrite
    // something a person put there — the deck is newer, not more authoritative.
    const filled: string[] = [];
    const set: string[] = [];
    const binds: unknown[] = [existing.id];
    for (const [col, value] of [
      ["sector", deal.sector],
      ["one_liner", deal.one_liner],
      ["website", deal.website],
    ] as const) {
      if (value && !existing[col]) {
        binds.push(value);
        set.push(`${col} = ?${binds.length}`);
        filled.push(col);
      }
    }
    if (set.length > 0) {
      await env.WP_OS_DB.prepare(`UPDATE canonical_company SET ${set.join(", ")} WHERE id = ?1`).bind(...binds).run();
    }

    const open = await env.WP_OS_DB.prepare(
      "SELECT id FROM investment_opportunity WHERE company_id = ?1 AND status NOT IN ('CLOSED','PASS','WITHDRAWN') LIMIT 1",
    )
      .bind(existing.id)
      .first<{ id: string }>();

    await appendEvent(env, {
      eventType: "dealflow.email_enriched",
      actorType: "ai_employee",
      actorId: DEAL_INTAKE_EMPLOYEE,
      objectType: "company",
      objectId: existing.id,
      firmScope,
      payload: { from: deal.from, filled, is_deck: deal.isDeck, already_open: Boolean(open) },
    });

    return {
      outcome: open ? "ALREADY_OPEN" : "ENRICHED",
      company_id: existing.id,
      opportunity_id: open?.id ?? null,
      detail:
        filled.length > 0
          ? `${existing.canonical_name} was already on the board; ${DEAL_INTAKE_EMPLOYEE} filled in ${filled.join(", ")} from this.`
          : `${existing.canonical_name} was already on the board and nothing here was missing.`,
    };
  }

  // Inserted directly rather than through the HTTP handler: that path answers with a Response and
  // its duplicate checks are the same ones already done above by canonical name.
  const companyId = `cc_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    `INSERT INTO canonical_company (id, canonical_name, website, privacy_label, created_by, sector, one_liner)
     VALUES (?1, ?2, ?3, 'INTERNAL', ?4, ?5, ?6)`,
  )
    .bind(companyId, deal.company, deal.website ?? null, `ai:${DEAL_INTAKE_EMPLOYEE}`, deal.sector ?? null, deal.one_liner ?? null)
    .run();

  const opportunity = await createOpportunity(env, actor, {
    company_id: companyId,
    opportunity_type: "EARLY_STAGE_PRIMARY",
    title: deal.company,
    // The funnel should say where a deal came from without anybody reconstructing it.
    source_channel: deal.isDeck ? "email:#wpdeck" : "email:#wpdealflow",
  });

  await appendEvent(env, {
    eventType: "dealflow.email_opened",
    actorType: "ai_employee",
    actorId: DEAL_INTAKE_EMPLOYEE,
    objectType: "investment_opportunity",
    objectId: opportunity.id,
    firmScope,
    payload: { from: deal.from, company: deal.company, is_deck: deal.isDeck },
  });

  return {
    outcome: "OPENED",
    company_id: companyId,
    opportunity_id: opportunity.id,
    detail: `${DEAL_INTAKE_EMPLOYEE} opened ${deal.company} at the top of the funnel. Nobody has decided anything about it.`,
  };
}
