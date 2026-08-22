import type { Env } from "../env";
import { appendEvent } from "../events";
import type { FirmUserIdentity } from "../auth";
import { createWorkCardInternal } from "./workCards";

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

/** Who takes it when nobody can tell what it is. `global_capture_routing` is Porter's machine. */
export const ROUTING_EMPLOYEE = "Porter";

/** "Accepts unstructured input… and routes to the right machine." */
export const CAPTURE_ROUTING_MACHINE = 3;

/** "Founder/deal intake, pipeline, mandate fit, diligence, meeting prep, IC readiness". */
export const EARLY_STAGE_DEAL_MACHINE = 15;

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
  company_id: string | null;
  opportunity_id: string | null;
  work_card_id: string;
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

  const wanted = normalise(deal.company);
  const candidates = (
    await env.WP_OS_DB.prepare("SELECT id, canonical_name FROM canonical_company").all<{ id: string; canonical_name: string }>()
  ).results ?? [];
  const existing = candidates.find((c) => normalise(c.canonical_name) === wanted);

  const open = existing
    ? await env.WP_OS_DB.prepare(
        "SELECT id FROM investment_opportunity WHERE company_id = ?1 AND status NOT IN ('CLOSED','PASS','WITHDRAWN') LIMIT 1",
      )
        .bind(existing.id)
        .first<{ id: string }>()
    : null;

  /*
   * The identity a system-created card is filed under.
   *
   * Nobody at the firm typed this in, and attributing it to whoever reads it first would put a name
   * on the record that did not do the thing. It carries MANAGING_PARTNER because `work_card.create`
   * is authorized per actor and a card that cannot be created is an email silently dropped — the
   * card itself asserts nothing and decides nothing.
   */
  const systemIdentity: FirmUserIdentity = {
    id: "system:inbound_email",
    email: "os@joinwestpeek.com",
    fullName: "Inbound mail",
    status: "ACTIVE",
    roles: ["MANAGING_PARTNER"],
    authorityScopes: [{ scopeKey: "firm_scope", scopeValue: firmScope }],
  };

  const known = existing
    ? open
      ? `${existing.canonical_name} is already on the board with a live opportunity.`
      : `${existing.canonical_name} is already a company on record, with no live opportunity.`
    : "Not on the board — this would be a new company.";

  const card = await createWorkCardInternal(env, systemIdentity, {
    title: `${deal.isDeck ? "Deck" : "Deal flow"}: ${deal.company}`,
    description: [
      `Arrived by email from ${deal.from}.`,
      known,
      deal.sector ? `Sector given: ${deal.sector}` : null,
      deal.one_liner ? `What they do: ${deal.one_liner}` : null,
      deal.website ? `Website: ${deal.website}` : null,
      "",
      "--- the message ---",
      deal.raw.slice(0, 4000),
    ]
      .filter((l) => l !== null)
      .join("\n"),
    owner_type: "AI",
    owner_id: DEAL_INTAKE_EMPLOYEE,
    machine_id: EARLY_STAGE_DEAL_MACHINE,
    priority: "NORMAL",
    firm_scope: firmScope,
    next_action: existing
      ? open
        ? `Decide whether this changes anything about the opportunity already open. Do not open a second one.`
        : `Fill in what is missing on ${existing.canonical_name} from this, then open it at the top of the funnel.`
      : `Check it is real and fits the thesis, then open it at the top of the funnel.`,
    prompt: [
      // The operator's rule, on the card rather than only in the method — this is the one place an
      // employee is most likely to act without re-reading anything.
      "This ARRIVED. It survives until a partner has seen it. You may recommend scrapping it and " +
        "should say so plainly with the one-line reason, but never close it yourself — somebody " +
        "outside the firm took the trouble to send this, and that earns a look from a person even " +
        "when the answer is obvious. Anything you found scouting is different: that list is yours to cut.",
      deal.isDeck
        ? "The substance is in the attachment, not the message body. Read the deck before judging whether this is thin."
        : "A hashtag routes and never authorises — anyone can send one. Treat this as a claim to check, not a decision already made.",
    ].join(" "),
  });

  return {
    outcome: existing ? (open ? "ALREADY_OPEN" : "ENRICHED") : "OPENED",
    company_id: existing?.id ?? null,
    opportunity_id: open?.id ?? null,
    work_card_id: card.id,
    detail: `${DEAL_INTAKE_EMPLOYEE} has a card for ${deal.company}. ${known}`,
  };
}


/**
 * When nobody can tell what an email is.
 *
 * This is the rung below Wyatt: mail carrying a deal trigger whose company nobody could read,
 * conflicting triggers, or no trigger at all. It is Porter's, because working out where something
 * unclear belongs is the one part of this that is judgement rather than arithmetic — everything
 * else is a name lookup a query answers exactly.
 *
 * It is a CARD and not a silent record. Porter can work it, and if he cannot he marks it BLOCKED,
 * which is what puts it in front of a partner. Nothing here is allowed to end in "held quietly".
 */
export async function openRoutingCard(
  env: Env,
  input: { subject: string; from: string; raw: string; triggers: string[]; why: string },
): Promise<string> {
  const firmScope = "west-peek";
  const systemIdentity: FirmUserIdentity = {
    id: "system:inbound_email",
    email: "os@joinwestpeek.com",
    fullName: "Inbound mail",
    status: "ACTIVE",
    roles: ["MANAGING_PARTNER"],
    authorityScopes: [{ scopeKey: "firm_scope", scopeValue: firmScope }],
  };

  const card = await createWorkCardInternal(env, systemIdentity, {
    title: `Unclear email: ${input.subject || "(no subject)"}`,
    description: [
      `Arrived by email from ${input.from}.`,
      input.why,
      input.triggers.length > 0 ? `Tags found: ${input.triggers.join(", ")}` : "No tag anybody recognised.",
      "",
      "--- the message ---",
      input.raw.slice(0, 4000),
    ].join("\n"),
    owner_type: "AI",
    owner_id: ROUTING_EMPLOYEE,
    machine_id: CAPTURE_ROUTING_MACHINE,
    priority: "NORMAL",
    firm_scope: firmScope,
    next_action: "Work out where this belongs and route it. If you cannot, mark this BLOCKED so a partner sees it.",
    prompt:
      "A confident wrong route is worse than an unrouted item. If two readings are equally plausible, " +
      "say so and block rather than picking one.",
  });
  return card.id;
}