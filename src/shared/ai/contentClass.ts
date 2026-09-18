/**
 * WHO IT GOES TO, AND WHAT IS IN IT, ARE TWO DIFFERENT QUESTIONS.
 *
 * ── THE DEFECT, IN THE OWNER'S WORDS ──────────────────────────────────────────────────────────
 *
 * "WHY IS INTERNAL STUFF COSTING A LOT? THAT IS BACKWARDS."
 *
 * And, on being shown what "INTERNAL" was being taken to mean:
 *
 * "ITS NOT DEAL TERMS OR LP INFORMATION SO IT DOESNT MATTER IF ITS USING THIS DATA TO TRAIN. WHO
 *  CARES ABOUT HIRING SEARCH AND EVENT KITS AND ROOM KITS. THEY ARE NOT PRIVATE INFO."
 *
 * Two concepts had been collapsed into one column:
 *
 *   RECIPIENT — internal vs external. Her rule, settled: "ITS INTERNAL IF IT GOES TO ME SEQUOIA OR
 *   SCOOTER." This governs PREVIEW AND APPROVAL. It is owned elsewhere and nothing here touches it.
 *
 *   CONTENT — private vs not. This governs WHICH MODELS MAY SEE IT. Only LP names, deal terms, fund
 *   figures and diligence material are barred from a route whose terms permit training.
 *
 * `sensitivity: "INTERNAL"` answers the FIRST question and was being read as an answer to the
 * second. Every training-permitting lane is capped at PUBLIC — correctly, and that cap does not
 * move — so labelling a room packet INTERNAL because a partner reads it made the packet ineligible
 * for two free, reasoning-capable models and left exactly ONE legal lane in the whole catalogue:
 * `anthropic/claude-sonnet-5`, the dearest model on the account. The router was not misrouting. It
 * had one legal choice and took it, on a hire search.
 *
 * ── DECLARATION, NOT DETECTION, AND THIS IS A DELIBERATE CHOICE ───────────────────────────────
 *
 * The obvious implementation is a regex over the prompt. It was tried in the sister system and it
 * failed exactly as such things fail: a notice containing the word "commitment" tripped a deal-term
 * pattern, every run scanned as LP material, and every free route was refused firmwide. A detector
 * over ordinary English prose is a guess wearing a rule's clothes.
 *
 * So the primary mechanism is an ALLOW-LIST OF MACHINES, named one at a time. A machine's work is
 * training-safe because somebody decided it is and left a diff saying so, which is reviewable, and
 * silent about everything it does not name — an unlisted machine keeps today's behaviour exactly.
 * There is no way for an unforeseen kind of work to become training-safe by accident.
 *
 * The regex exists too, but ONLY in the direction that can do no harm: it can REVOKE the
 * allow-list's verdict when the text contains an unmistakable LP or deal marker, and it can never
 * grant one. A false positive costs a fraction of a cent; a false negative would put a deal term on
 * a training lane. That asymmetry is why the two mechanisms point opposite ways.
 */

/**
 * Machines whose output is not private, named individually.
 *
 * Each of these is on the owner's own list — "hiring search and event kits and room kits… workshop
 * packets, social posts, run of show, blog help, Productions work" — and each is here because its
 * work product is either published, handed to a guest, or about people the firm is trying to hire.
 * None of it touches the private side of the fund.
 *
 * WHAT IS CONSPICUOUSLY ABSENT, and must stay absent: every INVESTMENT_OS, FUNDRAISING_LP_OS,
 * PORTFOLIO_OS, FINANCE_OS and LEGAL_COMPLIANCE_OS machine, plus RELATIONSHIP_OS (which holds LP
 * relationships) and GOVERNANCE (which reads everything else). Adding a row here is a decision
 * about where the firm's words may go, and it should look like one.
 */
export const PUBLIC_MODEL_APPROVED_MACHINE_KEYS: ReadonlySet<string> = new Set([
  // Event kits, room packets, run of show — handed to guests, so not private by construction.
  "west_peek_live_events",
  // Rooms and the community around them. What a member says in a Room is handled under its own
  // confidentiality rule at the source; what this machine produces is the programme around it.
  "community_intelligence",
  // Blog help, social posts, PR. Written to be published.
  "marketing_pr_content",
  // Sponsorship and experiential revenue — Productions work, pitched outward.
  "brand_sponsorship_revenue",
  "taste_layer",
  // Workshop packets.
  "venture_teaching",
  // Hiring searches: the people the firm is trying to hire, and the briefs it writes to find them.
  "external_helper_coordination",
]);

/**
 * Markers that force PRIVATE_MODEL_ONLY, whatever the card says.
 *
 * Deliberately few, and every one of them is a term of art that does not appear in ordinary prose
 * about an event or a hire. The words that did the damage in the sister system — "commitment",
 * "capital", "fund", "round", "investor" — are NOT here and must not be added: they are everyday
 * English in exactly the material this rule is meant to let through ("a commitment to the
 * programme", "the capital of the state", "fundraiser").
 *
 * Each entry is a multi-word phrase or a distinctly financial compound, which is what keeps the
 * false-positive rate near zero: "limited partner" is not a phrase that appears in a run of show.
 */
const PRIVATE_MODEL_ONLY_MARKERS: readonly RegExp[] = Object.freeze([
  // LP identity and the fundraising relationship.
  /\blimited partners?\b/i,
  /\bLPAC?\b/,
  /\bcapital call\b/i,
  /\bsubscription agreement\b/i,
  /\bside letter\b/i,
  /\bcommitment amount\b/i,
  // Deal terms.
  /\bterm sheet\b/i,
  /\bcap table\b/i,
  /\bpre-?money\b/i,
  /\bpost-?money\b/i,
  /\bliquidation preference\b/i,
  /\bpro ?rata rights?\b/i,
  /\bSAFE (?:note|agreement)\b/,
  /\bconvertible note\b/i,
  // Fund figures and diligence.
  /\bcarried interest\b/i,
  /\bmanagement fee\b/i,
  /\bnet (?:IRR|TVPI|DPI|MOIC)\b/i,
  /\bdata ?room\b/i,
  /\bdue diligence (?:questionnaire|request)\b/i,
]);

export interface ContentClassVerdict {
  /** PUBLIC_MODEL_APPROVED: may this run reach a route whose terms permit training on it? */
  publicModelApproved: boolean;
  /** Why, in one clause, for the run's explanation. Never silent. */
  reason: string;
  /** The marker that revoked a declaration, where one did. Named so a false positive is findable. */
  revokedBy?: string;
}

/**
 * The verdict for one run.
 *
 * FAILS CLOSED, TWICE OVER. A caller that declares nothing gets today's behaviour — no training
 * lane. A caller that declares PRIVATE_MODEL_ONLY is refused outright and the declaration is not even
 * consulted, because a caller asserting both has a bug and the safe reading of a bug is the
 * restrictive one. And a declaration is revoked by any marker in the text.
 *
 * IT CANNOT GRANT EGRESS BY ITSELF. This answers one question — may a training-permitting route
 * serve this content — and the provider's own `provider_data_policy` still has to allow the run's
 * label. Two independent gates, as the free-lane work already established.
 */
export function classifyContent(args: {
  /** The caller's explicit assertion that this content is not private. */
  declaredPublicModelApproved?: boolean;
  /**
   * PRIVATE_MODEL_ONLY: the caller's explicit assertion that this content must stay on a lane whose
   * terms forbid training. Wins over everything, including a machine on the allow-list.
   */
  declaredPrivateModelOnly?: boolean;
  /**
   * THE RUN'S OWN EGRESS LABEL, and a PUBLIC one is already the declaration.
   *
   * This clause exists because leaving it out would have been a REGRESSION dressed as a safety
   * improvement. The daily executive brief is labelled PUBLIC and has been for months — it is
   * assembled from third-party headlines and published market levels — and PUBLIC is a statement
   * about CONTENT, not recipient: it is the label that already means "this may leave the building".
   * Requiring a second, newer declaration on top of it would have made the firm's single largest
   * recurring job ineligible for the free lanes it was always entitled to, on the day they were
   * introduced. A PUBLIC label IS public-model-approved; there is nothing further to assert.
   */
  sensitivity?: string | null;
  /** The machine this work sits on, where there is one. */
  machineKey?: string | null;
  /** The text that would actually be sent. */
  inputs?: readonly string[];
}): ContentClassVerdict {
  if (args.declaredPrivateModelOnly === true) {
    return {
      publicModelApproved: false,
      reason: "this call is marked PRIVATE_MODEL_ONLY, so only a lane whose terms forbid training may serve it",
    };
  }

  const byMachine = Boolean(args.machineKey && PUBLIC_MODEL_APPROVED_MACHINE_KEYS.has(args.machineKey));
  const byLabel = args.sensitivity === "PUBLIC";
  const declared = args.declaredPublicModelApproved === true || byMachine || byLabel;
  if (!declared) {
    return {
      publicModelApproved: false,
      reason:
        "nothing has declared this content free of LP or deal material, so it is treated as private — " +
        "an undeclared call keeps the behaviour it had before content and recipient were separated",
    };
  }

  for (const marker of PRIVATE_MODEL_ONLY_MARKERS) {
    for (const text of args.inputs ?? []) {
      if (marker.test(text)) {
        return {
          publicModelApproved: false,
          revokedBy: marker.source,
          reason:
            `this card is marked PUBLIC_MODEL_APPROVED, but the text contains ${marker.source} — an LP or deal-term ` +
            `marker — so it was treated as PRIVATE_MODEL_ONLY and no training-permitting route may serve it`,
        };
      }
    }
  }

  return {
    publicModelApproved: true,
    reason: byLabel
      ? "this run is labelled PUBLIC, which already says the content may leave the firm, so a route whose terms permit training may serve it"
      : byMachine
      ? `this is ${args.machineKey} work — an event kit, a room packet, a hire search or a piece of writing meant to be ` +
        `published — which contains no LP names or deal terms, so a route whose terms permit training may serve it. ` +
        `Who the work is addressed to decides whether it previews; what is in it decides which models may see it, and ` +
        `these are not the same question`
      : "the caller declared this content free of LP and deal material, so a route whose terms permit training may serve it",
  };
}

/** The markers, for the tests and the validator. A rule nothing can enumerate cannot be proven. */
export const privateModelOnlyMarkers: readonly string[] = Object.freeze(PRIVATE_MODEL_ONLY_MARKERS.map((r) => r.source));
