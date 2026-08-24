import type { Env } from "../env";
import { appendEvent } from "../events";
import type { FirmUserIdentity } from "../auth";
import { json, type RouteContext } from "../router";
import { createWorkCardInternal, WorkCardError } from "./workCards";
import { actorFromIdentity, type Actor } from "./authorize";
import { createOpportunity, type CreateOpportunityInput, type OpportunityRow } from "./investment";

/**
 * THE ONE DOOR INTO THE FUNNEL.
 *
 * Item 7, and the note that opened it: "Four uncontrolled routes already exist while the page claims
 * 'the only way in'. Consolidate before adding." The page has since stopped lying; this file is the
 * other half — the four routes now converge on ONE function, `openIntoFunnel`, and differ only in
 * what they hand it and who picks up the resulting card.
 *
 * The operator's model, in her words: "its not about going str8 to the funnel is about opening a
 * work card for Wyatt to route it appropriately", and "its about creating work cards for these
 * employees to do the things." So three of the four routes do not write to the pipeline at all.
 * They raise work.
 *
 * THE FOUR ROUTES, and what is genuinely different about each:
 *
 *   MANUAL      A partner pressed "Add a company". She drove it herself and she is authenticated,
 *               so this is the only route that opens the record. No card: raising one would be
 *               asking an employee to confirm a decision a Managing Partner just made.
 *   EMAIL       `#wpdealflow` / `#wpdeck` to the intake mailbox. A hashtag is a public word — it
 *               routes, it never authorises — so this lands as a card for Wyatt. Mail nobody can
 *               read goes one rung down to Porter (`openRoutingCard`), which is not a funnel entry
 *               at all but the honest end of the ladder.
 *   NETWORK_OS  A company pushed across from the partner system. Network OS is authoritative for
 *               PEOPLE and this app is authoritative for DEALFLOW, so a push is a proposal about
 *               our own record and gets the same card, never a direct write.
 *   SCOUT       Wyatt's own proactive finds. Identical to the two above with one real difference:
 *               nobody outside the firm is waiting on an answer, so this list is his to cut. He may
 *               fast-no his OWN scouted items; he may never scrap inbound without a partner. Either
 *               way what he drops stays on the pass pile — a scout who can make his own misses
 *               disappear is a scout nobody can check.
 *
 * MATCH FIRST, ALWAYS, on every route. `#wpdeck` is explicitly for "a new company or fill in blanks
 * for a company already added with info missing", and every other route carries the same duplicate
 * risk: a follow-up about a company already on the board must not build a second row for it. One
 * implementation of that lookup lives here and every route uses it, because three copies of a
 * matching rule is three chances for the register to grow a second Sensori.
 *
 * PROVENANCE IS NOT OPTIONAL. Every arrival records who sent it, by which route, and when — on the
 * event spine as `dealflow.arrival`, and on the row itself as `source_channel` for the route that
 * writes one. It is the only evidence a Fund I has about whether its sourcing is repeatable, and it
 * is worthless if it is recorded on three routes out of four.
 */

// Both seats now live in `shared/intake/emailTriggers.ts` — the Dealflow page has to name them and
// a client cannot import from `src/worker`. Re-exported so existing importers here are unaffected.
import { DEAL_INTAKE_EMPLOYEE, INTAKE_MAILBOX, ROUTING_EMPLOYEE, seatId, strippedSubject } from "../../shared/intake/emailTriggers";
export { DEAL_INTAKE_EMPLOYEE, ROUTING_EMPLOYEE };

/** "Accepts unstructured input… and routes to the right machine." */
export const CAPTURE_ROUTING_MACHINE = 3;

/** "Founder/deal intake, pipeline, mandate fit, diligence, meeting prep, IC readiness". */
export const EARLY_STAGE_DEAL_MACHINE = 15;

/** The firm scope every intake route belongs to. Named once. */
const FIRM_SCOPE = "west-peek";

// ── The routes ──

export const INTAKE_ROUTES = ["MANUAL", "EMAIL", "NETWORK_OS", "SCOUT"] as const;
export type IntakeRoute = (typeof INTAKE_ROUTES)[number];

export interface RoutePolicy {
  /** The seat that picks it up. Null on the one route where a person already did the work. */
  owner: string | null;
  machine: number | null;
  /**
   * Does this route write the pipeline record itself?
   *
   * True for exactly one route, and that is the whole governance. A partner pressing a button in a
   * page she is authenticated into is a decision; anything arriving from outside is a claim.
   */
  opensRecord: boolean;
  /** May the seat holding it close it on its own judgement, with no partner? */
  finderMayScrap: boolean;
  /** How the card says where this came from. One line, for a person. */
  arrival: (from: string) => string;
  /** The standing instruction, on the card rather than only in a method nobody re-reads. */
  prompt: string;
  /** `source_channel` prefix on any row this route opens. `email:` is load-bearing — see below. */
  channel: string;
}

/**
 * ONE TABLE, READ BY EVERY ROUTE. The differences between the four are declared here rather than
 * scattered through four functions, so "what is actually different about the Network OS route" has
 * an answer you can read in one place instead of diffing two implementations.
 */
export const ROUTE_POLICY: Record<IntakeRoute, RoutePolicy> = {
  MANUAL: {
    owner: null,
    machine: null,
    opensRecord: true,
    finderMayScrap: true,
    arrival: (from) => `Entered by ${from}.`,
    prompt: "",
    channel: "manual",
  },
  EMAIL: {
    owner: DEAL_INTAKE_EMPLOYEE,
    machine: EARLY_STAGE_DEAL_MACHINE,
    opensRecord: false,
    finderMayScrap: false,
    arrival: (from) => `Arrived by email from ${from}.`,
    // The operator's rule, verbatim in intent: every arrival survives until a partner has seen it.
    prompt:
      "This ARRIVED. It survives until a partner has seen it. You may recommend scrapping it and " +
      "should say so plainly with the one-line reason, but never close it yourself — somebody " +
      "outside the firm took the trouble to send this, and that earns a look from a person even " +
      "when the answer is obvious. Anything you found scouting is different: that list is yours to cut.",
    // `email:` is read by the dealflow board to badge a deal "by email · not yet looked at". Changing
    // this prefix silently removes that badge, so it is a contract and not a label.
    channel: "email",
  },
  NETWORK_OS: {
    owner: DEAL_INTAKE_EMPLOYEE,
    machine: EARLY_STAGE_DEAL_MACHINE,
    opensRecord: false,
    finderMayScrap: false,
    arrival: (from) => `Pushed across from Network OS by ${from}.`,
    prompt:
      "This ARRIVED from the partner system. It survives until a partner has seen it. Network OS is " +
      "authoritative for the PERSON and this app is authoritative for the DEAL, so nothing here is " +
      "settled by the push — you may recommend scrapping it with the one-line reason, but never " +
      "close it yourself. Anything you found scouting is different: that list is yours to cut.",
    channel: "network_os",
  },
  SCOUT: {
    owner: DEAL_INTAKE_EMPLOYEE,
    machine: EARLY_STAGE_DEAL_MACHINE,
    opensRecord: false,
    finderMayScrap: true,
    arrival: (from) => `Found by ${from} while scouting.`,
    prompt:
      "You found this yourself. Nobody outside the firm is waiting on an answer, so this one IS " +
      "yours to drop — say why in one line and drop it, rather than filling a partner's queue with " +
      "your own near misses. What you drop still shows on the pass pile, so the firm can see what " +
      "you turned down. Inbound is the opposite and stays that way: never scrap something somebody " +
      "sent us without a partner.",
    channel: "scout",
  },
};

// ── What a route hands the door ──

export interface FunnelArrival {
  route: IntakeRoute;
  /** The company as this route names it. Matched, never trusted as new. */
  company: string;
  /** When the route already knows the register entry — the manual door always does. */
  company_id?: string | null;
  sector?: string | null;
  one_liner?: string | null;
  website?: string | null;
  /** WHO. The sender's address, the Network OS record, the partner, the scout. */
  source: string;
  /** WHEN it happened out there, not when we got round to reading it. */
  received_at?: string;
  /** The far system's own key for it, so the same push twice is recognisable as one arrival. */
  external_ref?: string | null;
  /** The evidence, verbatim: the message, the snapshot row, the scout's note. */
  raw?: string;
  /** True when the substance is in an attachment rather than in the text. */
  is_deck?: boolean;
  /** Anything else worth putting in front of whoever picks it up. */
  notes?: string[];
  /**
   * PDFs that arrived with it, base64, undecoded. Stored and queued for reading, never read here —
   * an email handler has 10ms of CPU and reading a deck is a model call.
   */
  attachments?: Array<{ filename: string; mediaType: string; dataBase64: string; bytes: number }>;
  /** MANUAL only: the partner who drove it. */
  actor?: Actor;
  /** MANUAL only: the record she is opening. */
  opportunity?: Omit<CreateOpportunityInput, "company_id">;
}

export interface FunnelEntry {
  route: IntakeRoute;
  /**
   * IN_FUNNEL   the record is open — only the manual route reaches this.
   * OPENED      not on the board; this would be a new company.
   * ENRICHED    on the board already, with no live opportunity.
   * ALREADY_OPEN on the board with a live opportunity — do not open a second one.
   */
  outcome: "IN_FUNNEL" | "OPENED" | "ENRICHED" | "ALREADY_OPEN";
  company_id: string | null;
  opportunity_id: string | null;
  opportunity: OpportunityRow | null;
  work_card_id: string | null;
  /** Who holds it now. Null when nobody has to: a partner already did the work. */
  owner: string | null;
  detail: string;
  /** The provenance record. Every arrival has one, on every route. */
  arrival_event_id: string;
}

/** Kept for the callers that only ever cared about the email shape. */
export type IntakeResult = FunnelEntry;

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
  /** Extra lines for the work card — what came attached, and what could not be read. */
  notes?: string[];
  /**
   * The PDFs that came with it, base64, undecoded.
   *
   * NOT READ HERE. Reading a deck is a model call and this path runs inside an email handler with
   * 10ms of CPU. The bytes are stored and a reading is queued; the employee's own step does the
   * work with its own budget. Store now, read later — the same shape the oversize path uses.
   */
  attachments?: Array<{ filename: string; mediaType: string; dataBase64: string; bytes: number }>;
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
  // Every forwarding prefix, not one — and the SAME rule the header-only path uses. See
  // `strippedSubject`; it lives in one place now because it was inlined here and there at once.
  const fromSubject = strippedSubject(subject);

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

/**
 * Case- and punctuation-insensitive, because "Acme, Inc." and "Acme Inc" are one company.
 *
 * THE COLLAPSE AT THE END IS LOAD-BEARING. Stripping a suffix word leaves a hole where it was, and
 * `trim()` only closes the hole at the ends. "Acme Inc Labs" normalised to `acme  labs` and "Acme
 * Labs" to `acme labs`, so the two failed to match and the same company was created twice — the
 * exact duplicate this function exists to prevent, triggered by a suffix appearing anywhere but
 * last, which is where it least looks like a suffix.
 *
 * And if the name is NOTHING BUT suffix words, the stripped form is kept rather than the empty
 * string: an empty key matches every other empty key, so two unrelated companies would fuse.
 */
function normalise(name: string): string {
  const bare = name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const stripped = bare.replace(/\b(inc|llc|ltd|corp|co)\b/g, " ").replace(/\s+/g, " ").trim();
  return stripped || bare;
}

export interface CompanyMatch {
  id: string;
  canonical_name: string;
  /** How it was found, so a card can say so rather than asserting a match with no reasoning. */
  matched_via: "id" | "canonical_name" | "alias";
}

/**
 * THE ONE LOOKUP. Every route calls this before anything else.
 *
 * Aliases as well as canonical names, because the register already knows how to say "that name is
 * this company" and a second row for a company we already track is the single thing the
 * CanonicalCompany model exists to prevent (D3).
 */
export async function matchFunnelCompany(env: Env, name: string, companyId?: string | null): Promise<CompanyMatch | null> {
  if (companyId) {
    const byId = await env.WP_OS_DB.prepare("SELECT id, canonical_name FROM canonical_company WHERE id = ?1")
      .bind(companyId)
      .first<{ id: string; canonical_name: string }>();
    if (byId) return { ...byId, matched_via: "id" };
  }

  const wanted = normalise(name);
  if (!wanted) return null;

  /*
   * A MERGED COMPANY MUST NEVER WIN A MATCH. It is the husk of a name somebody already decided was
   * a duplicate, and matching it would file a new arrival against a record nothing else reads —
   * quietly undoing the merge one deck at a time.
   */
  const companies = (
    await env.WP_OS_DB.prepare("SELECT id, canonical_name FROM canonical_company WHERE status <> 'MERGED'").all<{ id: string; canonical_name: string }>()
  ).results ?? [];
  const byName = companies.find((c) => normalise(c.canonical_name) === wanted);
  if (byName) return { ...byName, matched_via: "canonical_name" };

  const aliases = (
    await env.WP_OS_DB.prepare("SELECT company_id, alias FROM company_alias").all<{ company_id: string; alias: string }>()
  ).results ?? [];
  const byAlias = aliases.find((a) => normalise(a.alias) === wanted);
  if (!byAlias) return null;
  const owner = companies.find((c) => c.id === byAlias.company_id);
  return owner ? { ...owner, matched_via: "alias" } : null;
}

/**
 * The identity a system-created card is filed under.
 *
 * Nobody at the firm typed this in, and attributing it to whoever reads it first would put a name on
 * the record that did not do the thing. It carries MANAGING_PARTNER because `work_card.create` is
 * authorized per actor and a card that cannot be created is an arrival silently dropped — the card
 * itself asserts nothing and decides nothing.
 */
function systemIdentity(): FirmUserIdentity {
  return {
    id: "system:inbound_email",
    email: INTAKE_MAILBOX,
    fullName: "Inbound mail",
    status: "ACTIVE",
    roles: ["MANAGING_PARTNER"],
    authorityScopes: [{ scopeKey: "firm_scope", scopeValue: FIRM_SCOPE }],
  };
}

/** Who the event spine records as having caused this arrival. */
function arrivalActor(arrival: FunnelArrival): { actorType: "firm_user" | "ai_employee" | "system"; actorId: string } {
  if (arrival.route === "MANUAL") {
    return { actorType: "firm_user", actorId: arrival.actor?.firmUserId ?? arrival.source };
  }
  if (arrival.route === "SCOUT") {
    // The employee's ID, never their display name. `arrival.source` defaults to the display string,
    // and writing that under `actorType: "ai_employee"` is the same divergence that made intake
    // cards unworkable — it leaves an event trail that alternates between "Wyatt (AI)" and
    // "aie_wyatt (AI)" for the same colleague.
    return { actorType: "ai_employee", actorId: seatId(arrival.source) };
  }
  return { actorType: "system", actorId: arrival.route === "EMAIL" ? "inbound_email" : "network_os" };
}

/**
 * OPEN A COMPANY INTO THE PIPELINE. The one governed entry point; every route ends here.
 *
 * It always does the same four things in the same order — match, decide, act, record — and the route
 * only chooses which branch of "act" runs and whose name is on the card. Nothing else about a route
 * may differ, because the moment two routes have two implementations one of them starts drifting and
 * the page ends up describing a door that no longer works the way it says.
 */
export async function openIntoFunnel(env: Env, arrival: FunnelArrival): Promise<FunnelEntry> {
  const policy = ROUTE_POLICY[arrival.route];
  const receivedAt = arrival.received_at ?? new Date().toISOString();

  // 1. MATCH. Before anything is written, on every route.
  const existing = await matchFunnelCompany(env, arrival.company, arrival.company_id);
  if (arrival.company_id && existing?.matched_via !== "id") {
    // A route that names a register id is asserting the register already holds it. A miss there is a
    // mistake to report, never a licence to create a second company under a name we were not given.
    throw new Error(`canonical_company '${arrival.company_id}' does not exist`);
  }
  const open = existing
    ? await env.WP_OS_DB.prepare(
        "SELECT id FROM investment_opportunity WHERE company_id = ?1 AND status NOT IN ('CLOSED','PASS','WITHDRAWN') LIMIT 1",
      )
        .bind(existing.id)
        .first<{ id: string }>()
    : null;

  const known = existing
    ? open
      ? `${existing.canonical_name} is already on the board with a live opportunity.`
      : `${existing.canonical_name} is already a company on record, with no live opportunity.`
    : "Not on the board — this would be a new company.";

  let companyId = existing?.id ?? null;
  let opportunity: OpportunityRow | null = null;
  let workCardId: string | null = null;

  /*
   * 2a. THE REGISTER IS NOT THE PIPELINE, and conflating them made the deck feature a no-op.
   *
   * `opensRecord` used to gate BOTH creating the company record and opening an opportunity, so a
   * company arriving by email never got a `canonical_company` row at all. Everything downstream that
   * needs one — the deck reader above all — had nothing to attach to, and `deckQueue` skipped it for
   * ever while the job cheerfully reported "no decks waiting".
   *
   * They are different acts. The REGISTER is every company the firm has heard of; recording that we
   * heard of somebody commits nothing and is exactly what an arrival IS. The PIPELINE is a claim on
   * partner attention, and that still requires a human — which is what `opensRecord` actually meant
   * and now solely governs.
   *
   * The operator's own sentence needs both halves: "if its a new company they create a new one. if
   * existing they update it."
   */
  if (!companyId) {
    companyId = `cc_${crypto.randomUUID()}`;
    const registrar = arrival.actor?.firmUserId ?? `system:${policy.owner ?? "intake"}`;
    await env.WP_OS_DB.prepare(
      `INSERT INTO canonical_company (id, canonical_name, website, privacy_label, firm_scope, created_by, sector, one_liner)
       VALUES (?1, ?2, ?3, 'INTERNAL', ?4, ?5, ?6, ?7)`,
    )
      .bind(
        companyId,
        arrival.company.trim(),
        arrival.website ?? null,
        arrival.actor?.firmScopes[0] ?? FIRM_SCOPE,
        registrar,
        arrival.sector ?? null,
        arrival.one_liner ?? null,
      )
      .run();
    await appendEvent(env, {
      eventType: "identity.company_created",
      actorType: arrival.actor?.firmUserId ? "firm_user" : "system",
      actorId: registrar,
      objectType: "canonical_company",
      objectId: companyId,
      firmScope: arrival.actor?.firmScopes[0] ?? FIRM_SCOPE,
      payload: { canonical_name: arrival.company.trim(), via: arrival.route },
    });
  }

  if (policy.opensRecord) {
    /*
     * 2b. THE ROUTE THAT OPENS AN OPPORTUNITY. Exactly one, and it needs an authenticated actor —
     * the whole reason the other three raise cards is that they have nobody to attribute a claim on
     * partner attention to.
     */
    const actor = arrival.actor;
    if (!actor) throw new Error(`the ${arrival.route} route opens the record itself and needs the actor who drove it`);

    const wanted = arrival.opportunity;
    opportunity = await createOpportunity(env, actor, {
      ...(wanted ?? { opportunity_type: "EARLY_STAGE_PRIMARY", title: arrival.company.trim() }),
      company_id: companyId,
      // The route, on the row itself. A caller that already said where this came from is believed —
      // it knows more than the door does — but silence is filled in rather than left blank.
      source_channel: wanted?.source_channel ?? `${policy.channel}:${arrival.source}`,
    });
  } else {
    /*
     * 2b. THE ROUTES THAT PROPOSE. Identical work, different seat and different standing instruction.
     * Nothing enters the pipeline here; a card does, and an employee puts the company in.
     */
    const nextAction = existing
      ? open
        ? "Decide whether this changes anything about the opportunity already open. Do not open a second one."
        : `Fill in what is missing on ${existing.canonical_name} from this, then open it at the top of the funnel.`
      : "Check it is real and fits the thesis, then open it at the top of the funnel.";

    const card = await createWorkCardInternal(env, systemIdentity(), {
      title: `${arrival.is_deck ? "Deck" : arrival.route === "SCOUT" ? "Scouted" : "Deal flow"}: ${arrival.company}`,
      description: [
        policy.arrival(arrival.source),
        known,
        arrival.sector ? `Sector given: ${arrival.sector}` : null,
        arrival.one_liner ? `What they do: ${arrival.one_liner}` : null,
        arrival.website ? `Website: ${arrival.website}` : null,
        arrival.external_ref ? `Their reference: ${arrival.external_ref}` : null,
        ...(arrival.notes ?? []),
        "",
        "--- what came with it ---",
        (arrival.raw ?? "").slice(0, 4000),
      ]
        .filter((l) => l !== null)
        .join("\n"),
      owner_type: "AI",
      owner_id: policy.owner!,
      machine_id: policy.machine ?? undefined,
      priority: "NORMAL",
      firm_scope: FIRM_SCOPE,
      next_action: nextAction,
      prompt: [
        policy.prompt,
        arrival.is_deck
          ? "The substance is in the attachment, not the message body. Read the deck before judging whether this is thin."
          : "A hashtag routes and never authorises — anyone can send one. Treat this as a claim to check, not a decision already made.",
      ]
        .filter((line) => line.length > 0)
        .join(" "),
    });
    workCardId = card.id;
  }

  /*
   * THE DECK ITSELF, STORED AND QUEUED FOR READING.
   *
   * Operator: "if we snd a deck the employee extracts all relevant info and fills in gaps in the
   * deal flow tab's company card. if its a new company they create a new one. if existing they
   * update it." Creating or matching the company happened above; this is the half that reads.
   *
   * Stored, not read. `R2.put` takes the stream without decoding it and costs almost nothing, while
   * the model call that reads it would not fit in an email handler's 10ms. `deck_reading` picks it
   * up within fifteen minutes with its own budget.
   */
  for (const attachment of arrival.attachments ?? []) {
    if (!env.WP_OS_DOCUMENTS) break;
    /*
     * KEPT EVEN WHEN THERE IS NO COMPANY YET, which is the case the operator actually described:
     * "if its a new company they create a new one." The EMAIL route deliberately does not write the
     * pipeline — it raises a card and the analyst decides — so a brand-new company has no record to
     * attach a deck to at this moment. Discarding the bytes for that reason threw the deck away for
     * precisely the arrival it mattered most for, while the card raised in the same breath told the
     * analyst to read it.
     *
     * So the deck is stored against the WORK CARD when there is no company, and the reader fills a
     * record once one exists. Losing the attachment is not an acceptable way to respect a boundary.
     */
    const key = `decks/${companyId ?? "unmatched"}/${crypto.randomUUID()}.pdf.b64`;
    try {
      /*
       * STORED AS BASE64, EXACTLY AS IT ARRIVED. Not decoded here and not re-encoded later.
       *
       * The first version decoded base64 to bytes to store, and `deckQueue` then re-encoded those
       * bytes to base64 to hand to the model — two conversions over megabytes for no gain. A Worker
       * has 10ms of CPU and both directions are real CPU work, so on a five-megabyte deck the job
       * would have blown its budget and failed in a way that looked like an unreadable deck rather
       * than a coding mistake. MIME hands us base64 and Workers AI wants base64; the bytes in
       * between were nobody's requirement.
       */
      await env.WP_OS_DOCUMENTS.put(key, attachment.dataBase64, {
        httpMetadata: { contentType: "text/plain" },
        customMetadata: {
          filename: attachment.filename.slice(0, 200),
          encoding: "base64",
          mediaType: attachment.mediaType,
        },
      });
      await env.WP_OS_DB.prepare(
        `INSERT INTO pending_deck (id, company_id, work_card_id, filename, object_key, bytes, firm_scope)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      )
        .bind(`pdk_${crypto.randomUUID()}`, companyId ?? null, workCardId ?? null, attachment.filename, key, attachment.bytes, FIRM_SCOPE)
        .run();
    } catch (err) {
      // A deck that could not be stored is said out loud on the spine rather than dropped. The card
      // above already exists, so the arrival survives even when the attachment does not.
      await appendEvent(env, {
        eventType: "dealflow.deck_not_stored",
        actorType: "system",
        actorId: "deal_intake",
        objectType: "canonical_company",
        objectId: companyId ?? "unknown",
        firmScope: FIRM_SCOPE,
        payload: { filename: attachment.filename, detail: String(err).slice(0, 300) },
      });
    }
  }

  // 3. RECORD IT. Who, by which route, and when — on every route, without exception, because a
  // provenance trail with one gap in it cannot answer the question it exists for.
  const { actorType, actorId } = arrivalActor(arrival);
  const arrivalEventId = await appendEvent(env, {
    eventType: "dealflow.arrival",
    actorType,
    actorId,
    objectType: opportunity ? "investment_opportunity" : workCardId ? "work_card" : "canonical_company",
    objectId: opportunity?.id ?? workCardId ?? companyId ?? arrival.company.slice(0, 120),
    firmScope: FIRM_SCOPE,
    payload: {
      route: arrival.route,
      source: arrival.source,
      received_at: receivedAt,
      external_ref: arrival.external_ref ?? null,
      company: arrival.company,
      company_id: companyId,
      matched_via: existing?.matched_via ?? null,
      opportunity_id: opportunity?.id ?? null,
      work_card_id: workCardId,
      owner: policy.owner,
      is_deck: arrival.is_deck ?? false,
      finder_may_scrap: policy.finderMayScrap,
    },
  });

  const outcome: FunnelEntry["outcome"] = opportunity ? "IN_FUNNEL" : existing ? (open ? "ALREADY_OPEN" : "ENRICHED") : "OPENED";

  return {
    route: arrival.route,
    outcome,
    company_id: companyId,
    opportunity_id: opportunity?.id ?? null,
    opportunity,
    work_card_id: workCardId,
    owner: policy.owner,
    detail: opportunity
      ? `${arrival.company} is in the funnel, entered by ${arrival.source}.`
      : `${policy.owner} has a card for ${arrival.company}. ${known}`,
    arrival_event_id: arrivalEventId,
  };
}

// ── Route 2: email ──

/**
 * `#wpdealflow` / `#wpdeck` to the intake mailbox.
 *
 * A wrapper and nothing else. What used to live here — the match, the card, the standing
 * instruction — now lives in `openIntoFunnel`, which is the point of item 7: this route's only
 * remaining opinion is that mail is EMAIL and the sender is the source.
 */
export async function intakeDealFromEmail(env: Env, deal: EmailDeal): Promise<FunnelEntry> {
  return openIntoFunnel(env, {
    route: "EMAIL",
    company: deal.company,
    sector: deal.sector ?? null,
    one_liner: deal.one_liner ?? null,
    website: deal.website ?? null,
    source: deal.from,
    raw: deal.raw,
    is_deck: deal.isDeck,
    // FORWARDED, and they were not. This wrapper dropped both, so the PDF was extracted from the
    // MIME tree and then discarded one function later — the deck journey would have looked wired up
    // and stored nothing. A thin adapter that omits a field is the easiest place in a chain to lose
    // something, because it reads like plumbing rather than like logic.
    ...(deal.attachments ? { attachments: deal.attachments } : {}),
    ...(deal.notes ? { notes: deal.notes } : {}),
  });
}

// ── Route 4: the analyst's own scouting ──

export interface ScoutedCompany {
  company: string;
  sector?: string | null;
  one_liner?: string | null;
  website?: string | null;
  /** Where he found it — the database, the event, the portfolio founder who mentioned them. */
  where?: string | null;
  /** Why he thinks it is worth the firm's time. */
  note?: string | null;
  /** The scout. Named rather than "the system", because sourcing that works has an author. */
  scout?: string;
}

/**
 * Wyatt's proactive finds.
 *
 * Same door, same card, one real difference: he may fast-no his OWN list. His method is "check what
 * the firm has already touched before opening a database everybody else reads", which is exactly
 * what the match step does for him — so the card he opens already says whether the firm knows them.
 */
export async function intakeScoutedCompany(env: Env, find: ScoutedCompany): Promise<FunnelEntry> {
  return openIntoFunnel(env, {
    route: "SCOUT",
    company: find.company,
    sector: find.sector ?? null,
    one_liner: find.one_liner ?? null,
    website: find.website ?? null,
    source: find.scout ?? DEAL_INTAKE_EMPLOYEE,
    raw: find.note ?? "",
    notes: find.where ? [`Where he found them: ${find.where}`] : [],
  });
}

/** Same shape as every other handler's body reader: a malformed body is null, never a throw. */
async function parseJsonBody(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/**
 * A GOVERNED REFUSAL FROM THE FUNNEL, SAID OUT LOUD.
 *
 * `openIntoFunnel` raises a work card, and `createWorkCardInternal` can legitimately refuse to open
 * one: `403 forbidden` when authorize says no, and `429 opening_too_fast` when the breaker trips —
 * "Wyatt has opened 20 work cards in the last hour, past the 20 that means something is looping
 * rather than working." Both are deliberate and both are correct.
 *
 * Neither was ever TRANSLATED. The throw escaped the handler and the router answered
 * `500 {"error":"internal_error"}` — so a route into the funnel refused an arrival for a stated,
 * sensible reason and told the caller nothing at all. For the two unattended doors that is the
 * silent-failure shape this system already has a doctrine against: an arrival Network OS pushed or
 * the analyst found is dropped, and the only trace is a 500 in a log nobody reads.
 *
 * Now the status and the reason travel, exactly as they do everywhere else.
 */
export function funnelErrorResponse(err: unknown): Response {
  if (err instanceof WorkCardError) return json({ error: err.code, detail: err.message }, { status: err.status });
  throw err;
}

export async function handleScoutedIntake(ctx: RouteContext): Promise<Response> {
  const body = (await parseJsonBody(ctx.request)) as Partial<ScoutedCompany> | null;
  const company = typeof body?.company === "string" ? body.company.trim() : "";
  if (company.length < 2) {
    return json({ error: "invalid_input", detail: "a scouted company needs a name" }, { status: 400 });
  }
  try {
    const entry = await intakeScoutedCompany(ctx.env, {
      company,
      sector: body?.sector ?? null,
      one_liner: body?.one_liner ?? null,
      website: body?.website ?? null,
      where: body?.where ?? null,
      note: body?.note ?? null,
      // Named on the record even when the request does not say: the seat that scouts is the seat that
      // owns the top of the funnel, and an unattributed find is a find nobody can learn from.
      scout: typeof body?.scout === "string" && body.scout.trim() ? body.scout.trim() : DEAL_INTAKE_EMPLOYEE,
    });
    return json(entry, { status: 201 });
  } catch (err) {
    return funnelErrorResponse(err);
  }
}

// ── The rung below: when nobody can tell what an arrival is ──

/**
 * When nobody can tell what an email is.
 *
 * NOT a funnel entry, deliberately — it does not go through `openIntoFunnel` because there is no
 * company to open. It is the rung below Wyatt: mail carrying a deal trigger whose company nobody
 * could read, conflicting triggers, or no trigger at all. It is Porter's, because working out where
 * something unclear belongs is the one part of this that is judgement rather than arithmetic —
 * everything else is a name lookup a query answers exactly.
 *
 * It is a CARD and not a silent record. Porter can work it, and if he cannot he marks it BLOCKED,
 * which is what puts it in front of a partner. Nothing here is allowed to end in "held quietly".
 */
export async function openRoutingCard(
  env: Env,
  input: { subject: string; from: string; raw: string; triggers: string[]; why: string; headline?: string },
): Promise<string> {
  /*
   * THE HEADLINE IS THE CALLER'S, because not every routing card is an unclear email.
   *
   * This function hardcoded "Unclear email: " and the oversize path passed a subject that already
   * began "Too big to read: ", so the card an operator actually saw read "Unclear email: Too big to
   * read: Sensori deck". Two prefixes, and the first one wrong — a 14MB deck from a named founder
   * is not unclear, it is clear and too large, and those have different fixes. Home's counter was
   * looking for `title LIKE 'Too big to read:%'`, which could never match because of the prefix in
   * front of it; the count survived only because the other clause caught everything.
   */
  const card = await createWorkCardInternal(env, systemIdentity(), {
    title: `${input.headline ?? "Unclear email"}: ${input.subject || "(no subject)"}`,
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
    firm_scope: FIRM_SCOPE,
    next_action: "Work out where this belongs and route it. If you cannot, mark this BLOCKED so a partner sees it.",
    prompt:
      "A confident wrong route is worse than an unrouted item. If two readings are equally plausible, " +
      "say so and block rather than picking one.",
  });
  return card.id;
}

/** Convenience for the manual door, so its handler reads the same as the other three. */
export function manualArrival(identity: FirmUserIdentity, input: CreateOpportunityInput & { company: string }): FunnelArrival {
  const { company, company_id, ...opportunity } = input;
  return {
    route: "MANUAL",
    company,
    company_id,
    source: identity.fullName || identity.email || identity.id,
    actor: actorFromIdentity(identity),
    opportunity,
  };
}
