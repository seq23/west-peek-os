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

/*
 * THE DOORS.
 *
 * The first four answer a block that is a QUESTION — she knows something the employee does not.
 * The last four answer a block that is a FAULT — nobody is waiting on her judgement, something in
 * the machinery refused the work, and until 17 Sep 2026 she had no way to touch any of it. That
 * night a card failed three times because one lane's account was empty, and the only fix in
 * existence was someone editing a database row. RETRY, ANOTHER_LANE, PAUSE_LANE and HAND_ON are
 * that fix, in her hands, on the card.
 */
import type { LaneFailureKind } from "../ai/laneFailure";

export const BLOCK_ACTIONS = ["ANSWER", "CHANGE", "DROP", "ESCALATE", "RETRY", "ANOTHER_LANE", "PAUSE_LANE", "HAND_ON"] as const;
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
  // 17 Sep 2026 — a lane refused the work, or there was no lane left to try. The two shapes of
  // technical stop. Before these, both wore `tried_and_could_not_finish`, which says "they tried
  // three times" and offers her answers that could not possibly have helped.
  "a_lane_refused_the_work",
  "no_lane_could_take_the_work",
] as const;
export type BlockReason = (typeof BLOCK_REASONS)[number];

/**
 * The reasons that are a FAULT rather than a question for her.
 *
 * They read differently on the Work page, they carry the lane doors, and they nag on a gentler
 * interval — a dead lane may fix itself and she cannot act on one at two in the morning.
 */
export const TECHNICAL_BLOCK_REASONS: ReadonlyArray<BlockReason> = ["a_lane_refused_the_work", "no_lane_could_take_the_work"];

export function isTechnicalBlock(reason: string | null | undefined): boolean {
  return TECHNICAL_BLOCK_REASONS.includes((reason ?? "") as BlockReason);
}

const ANSWER = (label: string, hint: string, choices?: BlockAction["choices"]): BlockAction => ({ key: "ANSWER", label, hint, ...(choices ? { choices } : {}) });
const CHANGE: BlockAction = { key: "CHANGE", label: "Change what you asked for", hint: "Rewrite the job. They start again from your new words." };
const DROP: BlockAction = { key: "DROP", label: "Drop it", hint: "Decide it is not worth doing. Kept on the record with your reason, and they stop asking." };
const ESCALATE: BlockAction = { key: "ESCALATE", label: "Send it to an engineer", hint: "Nobody here can answer this one. It goes to whoever maintains the system, with what they need to fix it." };

/*
 * THE FOUR DOORS A FAULT NEEDS, and what each actually does on the server (services/blocks.ts).
 * Every hint says the real consequence, including how long a parked lane stays parked — a button
 * whose effect she has to guess at is a button she will not press.
 */
const RETRY: BlockAction = {
  key: "RETRY",
  label: "Try it again now",
  hint: "Puts the work straight back in the queue, on the same lane. Worth a press when whatever broke has since been fixed.",
};
const ANOTHER_LANE = (lane: string): BlockAction => ({
  key: "ANOTHER_LANE",
  label: "Send it to a different model",
  hint: `Stands ${lane} down for six hours and puts the work back in the queue, so the next run has to take the next lane instead.`,
});
const PAUSE_LANE = (lane: string): BlockAction => ({
  key: "PAUSE_LANE",
  label: "Stop using this one",
  hint: `Stands ${lane} down for a week, for every card and not just this one, and puts the work back in the queue. It comes back on its own.`,
});
const HAND_ON: BlockAction = {
  key: "HAND_ON",
  label: "Give it to somebody else",
  hint: "Pick a different employee. They start it again from the beginning, with a note saying why it moved.",
};

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
  /** The route that refused the work, named the way she would name it ("Anthropic", "OpenRouter"). */
  lane?: string;
  /** Which way it refused — see shared/ai/laneFailure.ts. */
  laneKind?: LaneFailureKind;
  /** The vendor's own sentence, used VERBATIM where it is readable and dropped where it is not. */
  vendorWords?: string;
}

/**
 * THE VENDOR'S OWN WORDS, OR NONE OF THEM.
 *
 * "your credit balance is too low to access the Anthropic API" is the single most useful thing
 * anybody could have put in front of her on 17 Sep, and no paraphrase of ours beats it. But an
 * adapter hands back whatever the vendor felt like sending, which is sometimes a stack trace, a
 * column name or a page of HTML — so the quote is offered to the SAME standard as the rest of the
 * sentence, and dropped silently if it fails. What is dropped is never lost: the raw text is kept
 * on the card behind "show me what it said".
 */
export function usableVendorWords(words: string | null | undefined): string {
  const said = (words ?? "").replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "");
  if (said.length < 12 || said.length > 120) return "";
  // Judged inside the sentence it will actually live in, not on its own.
  return plainLanguageProblems(`The lane refused the work — "${said}".`).length === 0 ? said : "";
}

/** What a lane did, in one plain sentence, with the vendor quoted when the quote is readable. */
function laneRefusal(f: BlockFacts): string {
  if (f.laneKind === "LEVER") return "The spend setting is on Free only, and this work needs a paid model, so it was held back.";
  const lane = (f.lane ?? "").trim() || "The lane it tried";
  const named = lane === "The lane it tried" ? lane : `The ${lane} lane`;
  const quote = usableVendorWords(f.vendorWords);
  if (quote) return `${named} refused the work — "${quote}".`;
  if (f.laneKind === "CREDIT") return `${named} turned the work away because the account behind it has run out of credit.`;
  if (f.laneKind === "CREDENTIAL") return `${named} would not let the work in, because the firm is no longer signed in to it.`;
  if (f.laneKind === "RATE_LIMIT") return `${named} is turning work away for now because too much has been sent to it at once.`;
  return `${named} refused the work and gave no reason anybody here can read.`;
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

  /*
   * EVERY ATTEMPT SPENT, AND NOTHING SAID (18 Sep 2026).
   *
   * `needed` now leads with what the LAST attempt actually said, when the card kept it.
   * `work_last_failure` has been written on every failed attempt since PR #94 — "Attempt 3 of 3
   * was refused by the Anthropic lane — the account behind it has run out of credit." — and it is
   * already written for a partner rather than for a log, which is why it can be put in front of
   * her verbatim instead of a fresh generic sentence being invented beside it.
   *
   * IT GOES IN `needed`, NOT IN `stopped`. `stopped` is held to ONE plain sentence by
   * `plainLanguageProblems`, and appending a second would fail the standard the sentence exists to
   * meet. `needed` is where an employee's own words already land.
   */
  stopped_part_way: (f) => ({
    stopped: `${f.employee} used every attempt on this and it stopped without reporting.`,
    needed: f.detail?.trim()
      ? `${f.detail.trim()} Say whether ${f.employee} should try again now, or drop it.`
      : `Say whether ${f.employee} should try again, or drop it.`,
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

  /*
   * A LANE REFUSED THE WORK — 17 Sep 2026, and the reason this whole file grew four doors.
   *
   * THE BLOCK THAT SHOULD HAVE EXISTED THAT NIGHT. What she got instead was "Open · queued — picked
   * up within 5 min", three times over fourteen minutes, while the direct Anthropic lane answered
   * every attempt with "your credit balance is too low to access the Anthropic API".
   *
   * WHO IS "SEQUOIA", NOT "ENGINEER", AND THAT IS THE WHOLE POINT. Every fix for tonight's failure
   * was hers: send it elsewhere, stand that lane down, top the account up, or hand the card on.
   * Calling it an engineering fault would have been true of the wiring and useless to her.
   *
   * THE STATUS CODE IS NOT THE HEADLINE and does not appear in `stopped` at all — `plainLanguage
   * Problems` would refuse it anyway. It is kept on the card, behind a disclosure, for whoever
   * wants it.
   */
  a_lane_refused_the_work: (f) => ({
    stopped: laneRefusal(f),
    needed:
      f.laneKind === "LEVER"
        ? "Set the spend setting to Moderate on the AI page, then try it again — or drop it for this month."
        : f.laneKind === "CREDIT"
        ? `Send it to a different model, or put more credit on the ${f.lane ?? "account it uses"} account.`
        : f.laneKind === "CREDENTIAL"
          ? `Send it to a different model, or get the firm signed in to ${f.lane ?? "that one"} again.`
          : f.laneKind === "RATE_LIMIT"
            ? "Send it to a different model, or try it again in a little while."
            : "Send it to a different model, stand that one down, or try it again.",
    who: f.who ?? "SEQUOIA",
    // A setting, not a lane: standing a lane down or sending it elsewhere cannot change it, and
    // offering those would be the same wrong doors this block exists to remove.
    actions: f.laneKind === "LEVER" ? [RETRY, HAND_ON, DROP] : [
      ANOTHER_LANE(f.lane ?? "that one"),
      PAUSE_LANE(f.lane ?? "that one"),
      RETRY,
      HAND_ON,
      DROP,
      // Money and sign-in are hers. A lane that is simply broken is not.
      ...(f.laneKind === "CREDIT" || f.laneKind === "CREDENTIAL" ? [] : [ESCALATE]),
    ],
  }),

  /*
   * NOTHING LEFT TO TRY. Distinct from the above because no single lane is at fault and standing
   * one down would make it worse — every one is already off, kill-switched or unaffordable.
   */
  no_lane_could_take_the_work: (f) => ({
    stopped: `${f.employee} had nowhere to send this — every model the firm can use is switched off or unavailable.`,
    needed: "Turn at least one of them back on from Integrations, or send this to an engineer.",
    who: f.who ?? "SEQUOIA",
    actions: [RETRY, HAND_ON, DROP, ESCALATE],
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
