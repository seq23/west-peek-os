/**
 * The firm's methods, written down once and read by whoever is doing the work.
 *
 * OPERATOR DIRECTION: "i feel like claude has many skills md and maybe that would be good to have a
 * skills library in the machines that each employee can pull from and not just random prompts", and
 * then: "department / machine skill library for each department makes sense. and the ai employees
 * adhere to them as guidelines?"
 *
 * Yes, and the diagnosis behind it is right. Today an employee's guidance is a persona line plus
 * whatever prompt the caller happened to write, so "how this firm screens a deal" lives scattered
 * across prompt strings in four services and drifts every time one is edited. Nothing states the
 * method, so nothing can be reviewed, corrected or disagreed with.
 *
 * A skill is the opposite: one place, in the firm's own words, that an employee reads before
 * working. It makes the firm's methods a reviewable artifact rather than prompt archaeology — you
 * can read a diff of how West Peek screens a deal.
 *
 * WHY KEYED BY MACHINE. The machine registry already models the firm as departments, and every
 * employee already declares which machines they primarily work. Keying skills the same way means
 * an employee's guidance follows from where they sit, with nothing maintained twice and nothing to
 * assign by hand.
 *
 * THEY ARE GUIDELINES, NOT RULES, and the distinction is load-bearing. A rule belongs in code where
 * it can be enforced — privacy labels, approval gates, spend caps are all rules and none of them
 * are here. These are how the firm prefers to think, and an employee that hits a case the guidance
 * did not anticipate should say so rather than contort the work to fit.
 *
 * WRITING RULE: a skill says what to DO and what makes an answer good. "Be thorough" is not a
 * skill. "Name the one assumption the thesis rests on, and say what would falsify it" is.
 */

export interface Skill {
  key: string;
  title: string;
  /** When this applies — so an employee can tell whether to use it. */
  when: string;
  /** The method itself, as lines an employee reads before working. */
  guidance: readonly string[];
}

export interface DepartmentSkills {
  /** machine.key from the machine registry. */
  machineKey: string;
  skills: readonly Skill[];
}

export const SKILL_LIBRARY: readonly DepartmentSkills[] = [
  {
    machineKey: "research_intelligence",
    skills: [
      {
        key: "source-quality",
        title: "Judging a source before believing it",
        when: "Any time a finding rests on something read rather than something the firm witnessed.",
        guidance: [
          "Say where a claim came from, every time. A finding with no source is an opinion.",
          "Rank what you have: the company's own filing beats its blog, which beats a journalist's",
          "  summary of the blog, which beats an aggregator repeating the journalist.",
          "A number with no date is not a number. Say when it was true.",
          "Two sources that both trace to the same press release are one source. Check before",
          "  calling something corroborated.",
          "When the sources disagree, say so and say which you believe and why. Do not average them",
          "  into a middle figure nobody reported.",
        ],
      },
      {
        key: "answer-the-question",
        title: "Answering the question actually asked",
        when: "Every research project.",
        guidance: [
          "Restate the question in one line before answering. If the restatement is not what was",
          "  meant, you have saved everyone a week.",
          "Answer first, evidence second. A partner should get the answer in the first sentence.",
          "Say what you could not find out. An absence you name is a finding; an absence you skip",
          "  over reads as a claim that nothing was there.",
          "Stop when the question is answered. More material is not more useful.",
        ],
      },
    ],
  },
  {
    machineKey: "early_stage_deal",
    skills: [
      {
        key: "screen",
        title: "Screening at the earliest stage",
        when: "First look at a company, before any diligence.",
        guidance: [
          "Screen against the written thesis, not against whether the company is interesting.",
          "  Interesting and in-mandate are different questions and only one of them is ours.",
          "At pre-seed there is no traction to underwrite, so you are underwriting the founder and",
          "  the market. Say which of the two you are betting on — it is almost never both equally.",
          "Name the one thing that has to be true for this to work. If you cannot, you do not yet",
          "  understand the company.",
          "A fast no is a service to everybody. Say no clearly and say why, in a sentence the",
          "  founder could act on.",
          "Never confuse a good meeting with a good company. Charisma is the most common false",
          "  positive at this stage.",
        ],
      },
      {
        key: "fund-return",
        title: "Whether it can return the fund",
        when: "Any deal that survives screening.",
        guidance: [
          "Work it backwards: what does this have to be worth at exit for our cheque to return the",
          "  fund, given the ownership we can get and keep after dilution?",
          "State the ownership after dilution, not at entry. Entry ownership flatters every model.",
          "If the answer requires an outcome larger than anything in the sector's history, say so.",
          "'Could be a unicorn' is not the test. The test is what the fund makes if it is right.",
        ],
      },
    ],
  },
  {
    machineKey: "ic_decision",
    skills: [
      {
        key: "dissent",
        title: "Keeping the disagreement alive",
        when: "Assembling or running an investment committee.",
        guidance: [
          "Write down the strongest reason NOT to invest, in its best form, before the decision.",
          "  A weak version of the opposing case is how a committee talks itself into things.",
          "Record dissent as dissent. Do not smooth it into consensus in the write-up.",
          "Name the assumption the whole thesis rests on, and what would falsify it. That is what",
          "  gets checked at three, six and twelve months.",
          "A contradiction in the evidence travels with the packet. Never resolve one by dropping",
          "  the inconvenient side.",
        ],
      },
    ],
  },
  {
    machineKey: "lp_fundraising",
    skills: [
      {
        key: "first-fund",
        title: "What a first-time manager has to prove",
        when: "Any LP conversation, document or update.",
        guidance: [
          "An LP is deciding whether you have a repeatable process, not whether you are clever.",
          "  Show the process.",
          "Never claim a track record you cannot evidence, and never imply one by omission.",
          "Specific beats impressive. 'We saw 340 companies and passed on 336' says more than",
          "  'highly selective'.",
          "Answer the question they asked, in the form they asked it. A diligence question answered",
          "  sideways reads as evasion even when it is not.",
          "Say what you do not do. A stated exclusion is evidence there is a real filter.",
        ],
      },
    ],
  },
  {
    machineKey: "portfolio_support",
    skills: [
      {
        key: "actually-help",
        title: "Help that lands",
        when: "A founder asks for something, or a company shows a signal worth acting on.",
        guidance: [
          "Find out what they actually need before offering what you have. The stated ask and the",
          "  real problem are frequently different.",
          "One concrete thing beats five introductions. Founders are drowning in offers to help.",
          "Close the loop: record whether the help landed. Unverified help is a story the firm",
          "  tells itself.",
          "A company that has gone quiet is a signal. Treat silence as information.",
        ],
      },
    ],
  },
  {
    machineKey: "marketing_pr_content",
    skills: [
      {
        key: "page-that-works",
        title: "Why a page does not convert",
        when: "Reviewing a landing page, a product page, or any page with a job to do.",
        guidance: [
          "Five seconds decides it: what is this, who is it for, why should I care. If those are",
          "  not answered above the fold, nothing below matters.",
          "One obvious next action. Three buttons of equal weight is zero calls to action.",
          "Every claim needs something behind it — a number, a name, a logo, a screenshot.",
          "  Unsupported superlatives make a visitor trust the rest of the page less.",
          "Check the phone first, not last. Most visitors are on one and most designs are not.",
          "Name what you can SEE, and what to change. 'Improve the hierarchy' is not advice;",
          "  'the headline and sub-head are the same weight so the eye has nowhere to land' is.",
          "Say when something is fine. Manufacturing problems is how a review stops being read.",
        ],
      },
    ],
  },
  {
    machineKey: "command_center",
    skills: [
      {
        key: "deliver",
        title: "Handing something to a partner",
        when: "Any brief, summary, agenda or answer that reaches a Managing Partner.",
        guidance: [
          "Lead with what changed and what it means, not with what you did to find out.",
          "If nothing happened, say that in one line. A manufactured update is worse than silence.",
          "Never present an inference as a fact. Mark what is read off a record and what is your",
          "  reading of it.",
          "Say what needs them specifically. A partner's attention is the scarcest thing here.",
          "Sign it. Everything the firm produces comes from somebody.",
        ],
      },
    ],
  },
];

/** Every skill that applies to an employee sitting on these machines. */
export function skillsForMachines(machineKeys: readonly string[]): Skill[] {
  const out: Skill[] = [];
  for (const key of machineKeys) {
    const dept = SKILL_LIBRARY.find((d) => d.machineKey === key);
    if (dept) out.push(...dept.skills);
  }
  return out;
}

/**
 * The guidance block an employee reads before working.
 *
 * Returns empty when a department has no skills yet, and the caller omits the section entirely
 * rather than printing an empty heading — an employee told "HOW THIS FIRM WORKS:" followed by
 * nothing has been told something false about the firm.
 */
export function guidanceBlock(machineKeys: readonly string[]): string {
  const skills = skillsForMachines(machineKeys);
  if (skills.length === 0) return "";
  return [
    "HOW THIS FIRM DOES THIS WORK.",
    "These are West Peek's own methods, written down by the partners. Follow them unless the work",
    "in front of you genuinely does not fit — and if it does not fit, say so rather than contorting",
    "the work to match. They are guidelines; the rules are enforced elsewhere and you cannot break",
    "them from here.",
    "",
    ...skills.flatMap((s) => [`${s.title} — ${s.when}`, ...s.guidance.map((g) => `  ${g}`), ""]),
  ].join("\n");
}
