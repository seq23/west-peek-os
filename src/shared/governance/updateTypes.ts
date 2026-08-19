/**
 * What a governance update IS, and which kind to reach for.
 *
 * WHY THIS EXISTS. The page offered a dropdown of five words — RULE, BULLETIN, BROADCAST,
 * CONTEXT_NOTE, VENDOR_UPDATE — a title and a body, and nothing else. Every one of those is a
 * different kind of act with a different consequence, and the screen said so nowhere. Faced with
 * five nouns and no guidance the honest response is to pick the first one and hope, which is how a
 * rule ends up filed as a bulletin and nobody is bound by it.
 *
 * THE DISTINCTION THAT ACTUALLY MATTERS is whether the thing BINDS. A rule changes what people and
 * employees may do; a bulletin tells them something. Confusing the two in either direction is
 * expensive — an unenforced rule is worse than none, and a bulletin dressed as a rule makes the
 * firm ignore the next real one.
 *
 * The examples are written for THIS firm — a first-time $30M fund with an AI workforce, a
 * community, and one closed SPV — rather than being generic governance filler. A sample nobody
 * recognises teaches nothing.
 */

export interface GovernanceUpdateType {
  key: string;
  label: string;
  /** One line: what this kind of update does. */
  what: string;
  /** When to reach for it, in the operator's terms. */
  when: string;
  /** Does it change what anyone is allowed to do? */
  binds: boolean;
  /** A real example for this firm. */
  example: { title: string; body: string };
}

export const GOVERNANCE_UPDATE_TYPES: readonly GovernanceUpdateType[] = [
  {
    key: "RULE",
    label: "Rule",
    what: "Changes what people and employees are allowed to do. Binding from the moment it is issued.",
    when: "You are setting a boundary you expect to be followed even when it is inconvenient.",
    binds: true,
    example: {
      title: "No external effect without a named approver",
      body:
        "Nothing leaves this firm — no email, no filing, no outreach — unless a Managing Partner has " +
        "approved that specific action. An employee may draft and recommend. It may not send. This " +
        "holds during a raise, and it holds when we are in a hurry.",
    },
  },
  {
    key: "BULLETIN",
    label: "Bulletin",
    what: "Tells the firm something it should know. Changes no permissions.",
    when: "Something happened, or is about to, and people should not learn it by accident.",
    binds: false,
    example: {
      title: "Fund I first close targeted for Q4",
      body:
        "We are working to a first close in Q4. LP conversations should assume that timeline, and " +
        "anything that would slow diligence needs to surface now rather than in November.",
    },
  },
  {
    key: "BROADCAST",
    label: "Broadcast",
    what: "A message to everyone at once, including the AI workforce, when reach matters more than nuance.",
    when: "Rare. Something needs to reach every employee immediately and cannot wait to be read in passing.",
    binds: false,
    example: {
      title: "Pause all outbound while we correct a mailing error",
      body:
        "Stop any outbound sequence now. A list was built from the wrong segment. Nothing goes out " +
        "until Willow confirms the list is rebuilt.",
    },
  },
  {
    key: "CONTEXT_NOTE",
    label: "Context note",
    what: "Explains WHY something is the way it is, so a decision made once is not re-argued every quarter.",
    when: "You decided something for reasons that will not be obvious to whoever reads it next.",
    binds: false,
    example: {
      title: "Why reserves are 40% of the early-stage sleeve",
      body:
        "At pre-seed, ownership survives the Series A only if we can follow. The deck's original $3M " +
        "was 10% of the fund, which meant watching our best company raise an A we could not " +
        "participate in. If this is revisited, revisit it against that outcome rather than against " +
        "the headline number.",
    },
  },
  {
    key: "VENDOR_UPDATE",
    label: "Vendor update",
    what: "Records a change in something the firm depends on — a provider, a price, a policy elsewhere.",
    when: "An outside system changed in a way that affects what this one can do or what it costs.",
    binds: false,
    example: {
      title: "Search model pricing changed",
      body:
        "The provider behind live search moved to a new rate. Daily briefing cost roughly doubles at " +
        "current volume, which is still cents rather than dollars. No action needed; recorded so the " +
        "next person reading the AI spend line knows why it stepped.",
    },
  },
] as const;

const BY_KEY = new Map(GOVERNANCE_UPDATE_TYPES.map((t) => [t.key, t]));

export function governanceType(key: string): GovernanceUpdateType | null {
  return BY_KEY.get(key) ?? null;
}

/**
 * What the firm has not yet written down but probably should.
 *
 * Deliberately RECOMMENDATIONS rather than requirements, and deliberately few. A governance page
 * that opens with fifteen missing policies teaches the operator that the list is decoration. These
 * are the three where this firm's own history already shows the cost of not having written it down.
 */
export interface GovernanceGap {
  key: string;
  suggests: string;
  title: string;
  because: string;
}

export const RECOMMENDED_GOVERNANCE: readonly GovernanceGap[] = [
  {
    key: "external_effect",
    suggests: "RULE",
    title: "What may leave the firm, and who approves it",
    because:
      "Outbound email is switched off behind two separate flags today, so the boundary is currently " +
      "held by configuration rather than by a decision. The day a credential arrives, the rule is " +
      "what stops it becoming a decision nobody made.",
  },
  {
    key: "placeholder_data",
    suggests: "RULE",
    title: "Provisional numbers may never reach an LP",
    because:
      "Sensori's entry price and share count are stand-ins, marked as such in the system. Nothing " +
      "currently stops a figure computed from them being pasted into a reporting pack, and that is " +
      "the mistake that is hardest to walk back.",
  },
  {
    key: "why_the_thesis",
    suggests: "CONTEXT_NOTE",
    title: "Why the thesis is what it is",
    because:
      "The mandate is versioned, so the WHAT is recorded. The reasoning is not, and it is the part " +
      "that gets re-argued — most usefully when the market makes a sector look temporarily wrong.",
  },
] as const;
