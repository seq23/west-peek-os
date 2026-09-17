/**
 * What a block has to say, and what the owner can do about it (16 Sep 2026).
 *
 * ─── The review that produced this, in the operator's words ─────────────────────────────────
 *
 * "parker is blocked on an assignment i gave him and i dont understand what he is blocked on and
 * how to help him myself … the reasoning sounds too technical."
 *
 * She was right, and the card proves it. Parker's October Workshop read:
 *
 *   "Could not finish after 3 attempts. Last attempt: DISCOVER: the judgement pass failed: the
 *    judgement was routed to the search model. Decide what to do with it: reassign, rewrite the
 *    brief, or cancel."
 *
 * Four things are wrong with that sentence and all four are fixed here rather than reworded:
 *
 *   1. IT NEVER SAYS WHAT HE WAS DOING. "Could not finish" — finish what? The assignment was "a
 *      packet on workshops much like he does for rooms" and the block does not contain the word
 *      workshop.
 *   2. THE CAUSE IS WRITTEN FOR AN ENGINEER. "DISCOVER", "the judgement pass", "routed to the
 *      search model" are three internal names in eleven words.
 *   3. IT ASKS HER FOR SOMETHING SHE CANNOT GIVE. "Reassign, rewrite the brief, or cancel" — none
 *      of those would have helped, because the cause was a wiring fault no brief can reach. The
 *      block asked the wrong person.
 *   4. THERE IS NO BUTTON. Even where the answer IS hers, the card is a dead end: the only way to
 *      act was to reassign it to a human or mark it done, both of which put a lie on the record.
 *
 * ─── So a block is four sentences and at least one door ─────────────────────────────────────
 *
 *   trying  — the assignment in the words it was given in, never an internal job key;
 *   stopped — ONE sentence a non-engineer understands, and the strict half of this file:
 *             `plainLanguageProblems` refuses a stack trace, an error code, a table or column
 *             name, a function name, an internal stage name or a second sentence;
 *   needed  — the specific thing that would clear it;
 *   who     — Sequoia, Scooter, or an engineer. Naming the wrong person is how a block rots.
 *
 * `stopped` IS OURS AND NEVER THE MODEL'S. An employee's own words land in `needed`, where a
 * question phrased for a person belongs; the sentence that explains the situation is written here
 * so it can be held to a standard. A cause that cannot be said in one plain sentence is a badly
 * modelled block, and the catalogue below is short for that reason.
 */

export const BLOCK_ACTIONS = ["ANSWER", "CHANGE", "DROP", "ESCALATE"] as const;
export type BlockActionKey = (typeof BLOCK_ACTIONS)[number];

export const BLOCK_PROVIDERS = ["SEQUOIA", "SCOOTER", "ENGINEER"] as const;
export type BlockProvider = (typeof BLOCK_PROVIDERS)[number];

export interface BlockAction {
  key: BlockActionKey;
  /** The button, in the words the owner would use. */
  label: string;
  /** One line under the button saying what pressing it does. */
  hint: string;
  /**
   * For ANSWER: fixed choices, when the answer is a yes or a no rather than a sentence. A choice
   * key the server knows about also DOES something (see `answerBlock`); an unknown one is just
   * the text of the answer.
   */
  choices?: Array<{ key: string; label: string }>;
}

export interface Block {
  reason: BlockReason;
  /** What the employee was trying to do, in the words the work was given in. */
  trying: string;
  /** What stopped them. One plain sentence. */
  stopped: string;
  /** What would clear it, specifically. */
  needed: string;
  /** Who can provide that. */
  who: BlockProvider;
  actions: BlockAction[];
}

/**
 * Every shape of block this system can produce. Nine, and that is the whole list — a tenth means
 * a new way for work to stop, which is a thing worth naming rather than a string a service
 * invented on the way past.
 */
export const BLOCK_REASONS = [
  "a_question_for_you",
  "permission_to_open_a_page",
  "tried_and_could_not_finish",
  "stopped_part_way",
  "the_request_is_gone",
  "nothing_good_enough_to_send",
  "nothing_new_since_last_time",
  "the_brief_is_missing",
  "the_file_would_not_build",
  "asked_for_something_this_work_cannot_do",
] as const;
export type BlockReason = (typeof BLOCK_REASONS)[number];

const ANSWER = (label: string, hint: string, choices?: BlockAction["choices"]): BlockAction => ({ key: "ANSWER", label, hint, ...(choices ? { choices } : {}) });
const CHANGE: BlockAction = { key: "CHANGE", label: "Change what you asked for", hint: "Rewrite the job. They start again from your new words." };
const DROP: BlockAction = { key: "DROP", label: "Drop it", hint: "Decide it is not worth doing. Kept on the record with your reason, and they stop asking." };
const ESCALATE: BlockAction = { key: "ESCALATE", label: "Send it to an engineer", hint: "Nobody here can answer this one. It goes to whoever maintains the system, with what they need to fix it." };

export interface BlockFacts {
  /** The assignment, in the words it was given in. */
  trying: string;
  /** Who is carrying it. */
  employee: string;
  /** The employee's own question or account, where the reason has one. */
  detail?: string;
  /** The page a permission block is about. */
  url?: string;
  /** Overrides the catalogue's default when the work belongs to Scooter's office. */
  who?: BlockProvider;
}

/**
 * The catalogue. Each entry writes the three sentences from facts and names the doors.
 *
 * WHY A FUNCTION AND NOT A STRING TABLE. The sentences have to carry the specifics — which
 * employee, which page, which month's packet — or they become a generic apology. What the table
 * fixes is the SHAPE: an entry cannot exist without a plain `stopped`, a `needed` and a door.
 */
const CATALOGUE: Record<BlockReason, (f: BlockFacts) => Omit<Block, "reason" | "trying">> = {
  a_question_for_you: (f) => ({
    stopped: `${f.employee} needs something from you before this can go any further.`,
    needed: f.detail?.trim() || "An answer to the question on the card.",
    who: f.who ?? "SEQUOIA",
    actions: [ANSWER("Answer it", `Type your answer. ${f.employee} reads it on the next run and carries on from where they stopped.`), CHANGE, DROP],
  }),

  permission_to_open_a_page: (f) => ({
    stopped: `${f.employee} wants to open a web page and needs your say-so first.`,
    needed: `Say whether ${f.employee} may open ${f.url ?? "the page named on the card"}.`,
    who: f.who ?? "SEQUOIA",
    actions: [
      ANSWER("Answer it", "Yes lets them read the page now. No sends them back to finish without it.", [
        { key: "allow_page", label: "Yes — open it" },
        { key: "deny_page", label: "No — carry on without it" },
      ]),
      DROP,
    ],
  }),

  tried_and_could_not_finish: (f) => ({
    stopped: `${f.employee} tried three times and could not get this done.`,
    needed: f.detail?.trim() || `Tell ${f.employee} what to do differently, change what you asked for, or drop it.`,
    who: f.who ?? "SEQUOIA",
    actions: [
      ANSWER("Answer it", `Type what to try instead. ${f.employee} starts again with your answer in front of them.`),
      CHANGE,
      DROP,
      ESCALATE,
    ],
  }),

  stopped_part_way: (f) => ({
    stopped: `${f.employee} was part way through this and the work stopped before they could report.`,
    needed: `Say whether ${f.employee} should try again, or drop it.`,
    who: f.who ?? "SEQUOIA",
    actions: [ANSWER("Answer it", `Type anything you want them to do differently, and ${f.employee} picks this up again.`), DROP, ESCALATE],
  }),

  the_request_is_gone: (f) => ({
    stopped: `What ${f.employee} was asked to build is no longer on the list, so there is nothing to work on.`,
    needed: "Drop this card, or ask for the thing again from its own page.",
    who: f.who ?? "SEQUOIA",
    actions: [DROP, ESCALATE],
  }),

  nothing_good_enough_to_send: (f) => ({
    stopped: `${f.employee} looked and found nothing solid enough to put in front of you.`,
    needed: f.detail?.trim() || `Point ${f.employee} at somewhere better to look, or drop it for this round.`,
    who: f.who ?? "SEQUOIA",
    actions: [ANSWER("Answer it", `Type where to look or what would count. ${f.employee} runs it again with that.`), CHANGE, DROP],
  }),

  nothing_new_since_last_time: (f) => ({
    stopped: `Everything ${f.employee} found this time you have already seen.`,
    needed: f.detail?.trim() || "Say whether to widen the search, or leave it until next time.",
    who: f.who ?? "SEQUOIA",
    actions: [ANSWER("Answer it", `Type what to widen to, and ${f.employee} runs it again.`), DROP],
  }),

  the_brief_is_missing: (f) => ({
    stopped: `${f.employee} cannot tell what was actually being asked for here.`,
    needed: f.detail?.trim() || "Say in your own words what you wanted, and who it is for.",
    who: f.who ?? "SEQUOIA",
    actions: [ANSWER("Answer it", `Type what you wanted. ${f.employee} treats that as the brief and starts.`), CHANGE, DROP],
  }),

  /*
   * SHE ASKED FOR SOMETHING THESE STEPS DO NOT DO, AND SAYING SO IS THE CORRECT ANSWER.
   *
   * The tenth reason, and the one the whole instruction-interpretation pass exists to produce.
   * Before it, a chain that could not honour part of what she typed did the default and reported
   * success — the "runs but inert" failure with a completed card on top of it. A stage whose input
   * includes prose it cannot carry now stops and hands it back, with the part it cannot do named.
   *
   * ANSWER and CHANGE are both offered because both are real: she may tell the employee how to
   * handle that part, or rewrite the job without it. DROP is there because deciding it is not
   * worth doing is also an answer.
   */
  asked_for_something_this_work_cannot_do: (f) => ({
    stopped: `${f.employee} can do most of what you asked for here, but not all of it.`,
    needed: f.detail?.trim() || `Say how you want the rest handled, or rewrite the job without it.`,
    who: f.who ?? "SEQUOIA",
    actions: [
      ANSWER("Answer it", `Say how you want that part handled. ${f.employee} starts again with your answer in front of them.`),
      CHANGE,
      DROP,
    ],
  }),

  the_file_would_not_build: (f) => ({
    stopped: `${f.employee} finished the work but the document would not come out as a file.`,
    needed: "Nobody here can fix this one — the part that makes the file is broken and needs an engineer.",
    who: "ENGINEER",
    actions: [ESCALATE, DROP],
  }),
};

/** Write a block from its reason and the facts of the card. */
export function describeBlock(reason: BlockReason, facts: BlockFacts): Block {
  const rest = CATALOGUE[reason](facts);
  return { reason, trying: facts.trying.trim(), ...rest };
}

/**
 * The one paragraph a person reads on the card. Kept here so the page, the notice, the email and
 * `next_action` all say the same words — a block that reads one way on Home and another in the
 * inbox is two blocks.
 */
export function blockSentence(b: Block): string {
  const who =
    b.who === "ENGINEER"
      ? "This one needs an engineer."
      : b.who === "SCOOTER"
        ? "Scooter can settle this."
        : "You can settle this.";
  return `${b.stopped} What was asked for: ${b.trying}. What would clear it: ${b.needed} ${who}`;
}

// ── The standard, enforced ────────────────────────────────────────────────────────────────────

/*
 * WHAT IS BANNED FROM `stopped`, AND WHY EACH ONE IS ON THE LIST.
 *
 * Every pattern here was in a real block reason this repo produced. The point is not tidiness: a
 * partner who reads "asset_id null on evt_deck" learns nothing and cannot act, so the sentence has
 * failed at the only job it has. Where the underlying cause genuinely is one of these things, the
 * block is an ENGINEER block and says so in plain words — it does not paste the cause in.
 */
const BANNED: ReadonlyArray<{ pattern: RegExp; why: string }> = [
  { pattern: /\b[a-z][a-z0-9]*_(id|json|at|url|key|md|by|count|usd|name|type|scope|stage|text|reason|mode)\b/i, why: "a column name" },
  { pattern: /\b(work_card|evt_\w+|ai_\w+|firm_user|approval_\w+|scheduled_job|provider_\w+|network_\w+)\b/i, why: "a table name" },
  { pattern: /\b[A-Za-z_][A-Za-z0-9_]*\(\)/, why: "a function name" },
  { pattern: /\b(null|undefined|NaN)\b/, why: "a programming value" },
  { pattern: /\b(HTTP|status)\s*[1-5][0-9]{2}\b|\[code:|\bSQLITE_|\bECONN|\bETIMEDOUT\b/i, why: "an error code" },
  { pattern: /\b\w+Error\b|\bstack trace\b|\bat [\w./]+:\d+/i, why: "a stack trace" },
  { pattern: /\b(DISCOVER|CONCEPTS|PACKET|RESEARCH|VENUES|QUEUED|IN_PROGRESS|BLOCKED_DEFERRED|EGRESS_BLOCKED|PREFLIGHT_BLOCKED|BUDGET_BLOCKED|ROOM_PACKET|BLOG_HELP|PRODUCTIONS_\w+|DECK_REWORK)\b/, why: "an internal stage or job name" },
  { pattern: /\b[a-z]+[A-Z][A-Za-z0-9]*\b/, why: "an internal identifier" },
  { pattern: /\b(the model|the router|a token|the prompt|the endpoint|the binding|the payload|the schema|the parser|the migration)\b/i, why: "a piece of the machinery" },
];

/**
 * Why this sentence is not fit for a partner to read. Empty means it is.
 *
 * ONE SENTENCE, and that is not a style rule. A cause that needs two sentences is nearly always
 * two causes wearing one block, and the second one is the one nobody acts on.
 */
export function plainLanguageProblems(stopped: string): string[] {
  const problems: string[] = [];
  const s = stopped.trim();
  if (s.length < 15) problems.push("it does not say anything");
  if (s.length > 200) problems.push("it is too long to be one plain sentence");
  // A full stop mid-string means a second sentence. A decimal or an abbreviation would not have a
  // space and a capital after it.
  if (/[.!?]\s+[A-Z]/.test(s)) problems.push("it is more than one sentence");
  if (!/[.!?]$/.test(s)) problems.push("it is not a finished sentence");
  for (const b of BANNED) if (b.pattern.test(s)) problems.push(`it contains ${b.why}`);
  return problems;
}

/** The same check over a whole block: the sentence, and the doors. */
export function blockProblems(b: Pick<Block, "trying" | "stopped" | "needed" | "who" | "actions">): string[] {
  const problems = plainLanguageProblems(b.stopped);
  if (!b.trying.trim()) problems.push("it does not say what the employee was trying to do");
  if (b.needed.trim().length < 5) problems.push("it does not say what would clear it");
  if (!BLOCK_PROVIDERS.includes(b.who)) problems.push("it does not say who can clear it");
  if (b.actions.length === 0) problems.push("it offers no way to act");
  // An ESCALATE-only block is legitimate; an ANSWER door that says nothing is not.
  for (const a of b.actions) {
    if (!BLOCK_ACTIONS.includes(a.key)) problems.push(`"${a.key}" is not a way to act`);
    if (!a.label.trim() || !a.hint.trim()) problems.push(`the "${a.key}" button does not say what it does`);
  }
  return problems;
}

/**
 * Proof that the catalogue itself passes, over every reason. Used by the validator and by the
 * tests; exported so neither has to re-derive the fact set.
 */
export function auditCatalogue(): Array<{ reason: BlockReason; problems: string[] }> {
  const facts: BlockFacts = {
    trying: "Build the October 2026 Workshop packet",
    employee: "Parker",
    url: "https://example.com/a-page",
  };
  return BLOCK_REASONS.map((reason) => ({ reason, problems: blockProblems(describeBlock(reason, facts)) }));
}
