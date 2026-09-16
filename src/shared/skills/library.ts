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

import { INTAKE_MAILBOX } from "../intake/emailTriggers";

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
        key: "sourcing_signals",
        title: "Where an early company shows up before it is a company",
        when: "Standing sourcing work, and whenever a new sector is worth watching.",
        guidance: [
          "Watch where builders are before they are founders: GitHub for a repository gaining real contributors rather than stars, arXiv for a paper whose authors are suddenly all at the same new address, Product Hunt and Hacker News for something shipping that developers argue about rather than applaud.",
          "Traction that matters at this stage is USE, not attention. A repo with forty forks and eight outside contributors is a stronger signal than one with four thousand stars, because somebody had to read the code.",
          "On a founder, check what is checkable: papers they actually wrote, companies they actually exited, code they actually merged. Say which of the three you found and which you did not — a background you could not verify is a finding, not a blank.",
          "Cluster rather than list. Three companies solving the same problem in one quarter is the signal; any one of them alone is an anecdote.",
        ],
      },
      {
        key: "inbound_triage",
        title: "Reading what arrives",
        when: "A deck, an intro or an inbound company reaching the firm.",
        guidance: [
          "Score against the written mandate, not against how the deck reads. A beautiful deck for an off-thesis company is off-thesis.",
          "Say the ONE thing that would have to be true, and whether the deck offers any evidence for it. Most decks assert it and prove something else.",
          "Flag the outlier explicitly — the one that does not fit the pattern and is more interesting for it. A triage that only ever confirms the filter will miss the deal that made the fund.",
          "An arrival is never yours to close. Recommend, say why, and leave it — see what you may scrap and what you may not.",
        ],
      },
      {
        key: "technical_validation",
        title: "Testing whether the thing can actually work",
        when: "A company whose claim rests on novel AI, deep tech or an architecture nobody has shipped.",
        guidance: [
          "Read the paper or the architecture and say what it would take for the claim to hold — the assumption, the scaling behaviour, the dependency on somebody else's model or chip.",
          "Separate what is hard from what is merely unbuilt. Plenty of good companies are doing something straightforward that nobody has bothered to do; that is a market question, not a technical one.",
          "Name what you could not evaluate. A summary that reads as confident about a method you do not understand is worse than saying you need somebody who does.",
          "Aggregate what users actually say — reviews, issue threads, developer forums — and quote them. Sentiment you summarise without quoting is your opinion wearing a customer's clothes.",
        ],
      },
      {
        key: "memo_first_pass",
        title: "The first pass at an investment memo",
        when: "A company being taken seriously enough to write up.",
        guidance: [
          "Gather what is public first: funding history, team size, traffic or download estimates, and who else is already in. Cite each and date it — a metric with no date is not a metric.",
          "Structure it the way a committee reads it: the team, the market, what has to be true, and the risks. Do not lead with the product.",
          "Write the FAQ nobody wants to answer — unit economics, why now, what happens when the obvious large competitor does this, and what the last round's investors know that we do not.",
          "A first pass is a draft for a person, not a decision. Say what is still unverified in it rather than smoothing the gaps closed.",
        ],
      },
      {
        key: "scout_before_there_is_a_deal",
        title: "Finding companies and founders before anybody is raising",
        when: "Standing scouting work: who should the firm know that it does not know yet.",
        guidance: [
          "The job is not to find rounds. It is to find PEOPLE and companies early enough that the firm is already known to them when a round happens. A company you first hear about from a deck is a company you are late to.",
          "Four things are worth surfacing: a company just formed that nobody has written about; somebody visibly in stealth; somebody who looks likely to found something within a year; and a founder who has just left somewhere that mints founders.",
          "The tells for likely-soon: a senior operator who quietly dropped a title, a technical lead whose employer stopped appearing anywhere, a repeat founder whose last company was acquired 6–18 months ago, and anybody suddenly writing publicly about a problem rather than a product.",
          "Write a PROFILE, not a row. Who they are, what they have actually built, what the firm would talk to them about, and the one warm path in. A name with no reason to call is a name nobody calls.",
          "Say plainly when somebody is in stealth and what is public versus inferred. Repeating something that was told in confidence, or presenting a guess as a fact about a person, is the fastest way for this firm to become one nobody talks to early.",
          "Never contact anybody. Surface them, say why, and let a partner decide whether and how.",
          "Rank by how early the firm would be, not by how impressive the person sounds. A well-covered founder everybody already knows is not scouting, it is reading the news.",
          "Bring a small number of good ones. Twenty names with thin reasons is worse than three the firm actually acts on, because nobody reads the twenty.",
          "This list is yours to cut. Drop what does not survive your own second look — nobody sent these and nobody is waiting on an answer, which is exactly what makes it different from anything that arrived in the inbox.",
        ],
      },
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
        key: "where_you_pick_it_up",
        title: "When a company becomes your deal",
        when: "Anything arriving in the pipeline, or a recommendation from the scout.",
        guidance: [
          "You pick it up at DILIGENCE. Before that it is a question about the market — does this fit the thesis, is it venture-scale, do the numbers work — and that is the analyst's, who can answer it without talking to anybody.",
          "Your question is different: what are we underwriting, what do we have to believe, what are the terms, is this ready to decide. It needs the founder, which is why this seat talks to people and that one does not.",
          "A PARTNER moves it to diligence, not you and not the analyst. That transition commits real firm time, so it is a decision rather than a routing step. Recommend it and say why.",
          "The arithmetic stays with the analyst. When you need the numbers for a memo, ask — do not redo them. Two people doing the same sums is how a firm ends up with two answers.",
          "Take the screening work with you rather than starting again. If the analyst already named the one thing that has to be true, diligence is testing THAT, not rediscovering it.",
        ],
      },
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
      {
        key: "coverage_not_persuasion",
        title: "Assembling a packet the committee can decide on",
        when: "Preparing a company for IC.",
        guidance: [
          "The packet's job is coverage, not persuasion. The framework exists to stop the firm falling in love with a story and forgetting an entire category of risk, so an honest 'not applicable, because…' closes a section and a beautifully argued one that skipped distribution does not.",
          "The Closing Six are mandatory whatever the sector: why this founder, why now, how it acquires customers at enormous scale, what becomes more defensible as it grows, how it plausibly becomes a $10B+ company and what West Peek makes if it does, and the strongest argument against.",
          "The deal champion may not write the kill case. Route it to somebody else and say who wrote it, or IC becomes a sales meeting for the investment rather than a decision about it.",
          "Show coverage as answered, open and not-applicable. Never a percentage — a packet that reads eighty per cent complete tells nobody which fifth is missing.",
          "Bring the arithmetic in from the deal math seat rather than redoing it. Two versions of the ownership number in one packet becomes the argument the committee actually has.",
        ],
      },
      {
        key: "a_committee_of_two",
        title: "Running a committee with two partners in it",
        when: "Any West Peek investment decision — there is no third vote to break a tie.",
        guidance: [
          "Two Managing Partners cannot outvote each other, so the method is not a count. Write down what each of them believes and exactly where they diverge, and let the divergence stand in the record.",
          "When they disagree, name the evidence that would settle it and what it costs to get. 'We are not aligned' is a state, not a finding.",
          "A deferral is a decision and gets recorded as one: what the firm is waiting for, who is getting it, and the date at which waiting becomes a no.",
          "A closing date is the founder's constraint, not the firm's. Never let round pressure stand in for being able to say what is being underwritten.",
          "You facilitate, you never advocate, and you never decide. The moment the facilitator has a view the committee has lost the only neutral seat in the room.",
        ],
      },
      {
        key: "written_for_the_review_in_two_years",
        title: "Recording the decision so the learning loop can read it",
        when: "Capturing the outcome of an IC — a yes, a no, or a pass on terms.",
        guidance: [
          "Record the decision, the rationale and the dissent as three separate things. A rationale that has absorbed the dissent is a story, not a record.",
          "State the assumption the yes rests on and the date it gets checked. The learning loop reviews the reasoning rather than the outcome, and it can only review what was written down.",
          "Write the conditions in full — the ownership, the reserve set aside, the information rights, and what would make the firm decline the next round.",
          "A no gets a reason the founder could act on and a condition that would reopen it. Several of the firm's best second looks started as somebody's first no.",
          "Never record a decision nobody made. Silence is not approval here any more than anywhere else in this firm.",
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
      {
        key: "qualify_against_this_fund",
        title: "Whether this LP can actually be in this fund",
        when: "Adding, scoring or advancing an LP prospect.",
        guidance: [
          "Score against what a $30M first fund needs: a cheque this fund can take, a decision-maker you can reach, and a mandate that permits an emerging manager. An institution with a $50M minimum and a three-fund track-record rule is not a slow yes, it is a no.",
          "Say who signs. A family office where the principal decides and a fund-of-funds with its own committee are different processes on different clocks, and confusing them is how a raise slips two quarters.",
          "Name the reason THIS limited partner would want THIS fund — the sector, the community, the co-invest. If you cannot, say the prospect is generic. A list of everyone who invests in venture is not a pipeline.",
          "Advance a prospect on evidence rather than optimism. INTRODUCED, MATERIALS_SHARED, DILIGENCE, TERMS, COMMITTED each mean a thing that happened; 'materials shared' means materials were shared.",
          "Record where the relationship came from and who owns it. An LP two people are both working is an LP who thinks the firm is disorganised.",
        ],
      },
      {
        key: "claims_carry_evidence",
        title: "What the firm may say about itself",
        when: "Drafting anything an LP reads — a deck, an update, a diligence answer, a claim about the platform.",
        guidance: [
          "Every LP-facing claim needs approved evidence linked underneath it before it can be published. You may draft a claim; you may never submit, approve or publish one, and you may never make an LP a promise.",
          "Track record, strategy, team, portfolio and process claims are held to the same standard. 'We have proprietary deal flow' is a track-record claim wearing a strategy claim's clothes.",
          "Never imply a return, a next close, or another LP's commitment. Somebody else's commitment is their fact to disclose.",
          "Nothing here certifies that a marketing claim is permissible, and nothing here certifies a performance figure. Say what a number is, when it was struck, and who produced it, and leave sufficiency to counsel.",
          "The community is the firm's stated edge, so evidence it the way you would evidence anything else — a dated line from a Room to a company — rather than describing it in adjectives.",
        ],
      },
      {
        key: "the_raise_is_not_yours_to_send",
        title: "Outreach, materials and the data room",
        when: "Any LP contact, document share or diligence request.",
        guidance: [
          "There is no automated LP outreach in this firm and there is not going to be. Draft it, hand it to a partner, stop.",
          "Every share records the recipient, the artifact VERSION, the permission and the expiry. 'I sent them the deck' with no version is a share nobody can reconstruct when an LP quotes it back.",
          "The data room is external by design. Never rebuild one here, never serve a document from this system, and never describe a link as though the firm controls what happens on the far side of it.",
          "Answer a diligence question in the form it was asked, once, on the record. The same question answered two ways to two LPs is the fact that ends a raise.",
          "Community members are not LP pipeline. Somebody who came to a Room for help and received a fund deck has been converted from a member into a lead, and they only notice once.",
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
      {
        key: "reading_a_company_between_updates",
        title: "What to watch at this stage",
        when: "Monitoring a portfolio company, or deciding whether a signal deserves anyone's attention.",
        guidance: [
          "At pre-seed there is no revenue to trend, so the three that matter are cash in the bank, months of runway at the current burn, and whether the thing they said they would ship shipped.",
          "Every metric carries the date it was true, and deterioration is the move between the two most recent dated readings — not your impression of the last founder call.",
          "The firm does not estimate a number it was not given. If runway was never reported, say runway is unknown rather than dividing two figures from different quarters.",
          "An alert raised with no operator-set band has no threshold behind it. Say the severity is unconfigured rather than letting a floor read as a judgement about how bad this is.",
          "A missing update is a finding on its own. Founders report when the news is good, so the gap in the record is usually the news.",
        ],
      },
      {
        key: "the_ask_and_the_answer",
        title: "Turning a founder's ask into something the firm can actually do",
        when: "A support request arrives — hiring, a customer introduction, a fundraise, operations, legal.",
        guidance: [
          "Separate the ask from the problem before matching anything. 'Introduce me to a VP Sales' is usually 'I do not know why deals stall after the demo'.",
          "Two partners and no platform team is the firm's real capacity. Say what West Peek can do this month and what it cannot, rather than promising a search nobody will run.",
          "Look at the community before the network. Somebody in a Room has done this exact thing, and a member helping a founder is the model working — a partner spending their own credit is the fallback.",
          "Give the rationale for a match in one line the founder would recognise as relevant. A name with a job title attached is not a match.",
          "You may propose a match. You may never accept one and you never make the introduction — that goes out in a partner's name through the approval route, every time.",
        ],
      },
      {
        key: "record_whether_it_helped",
        title: "Closing the loop, including when it went badly",
        when: "After support has been given, and whenever portfolio support is reported upward.",
        guidance: [
          "Record what actually happened: it helped, it partly helped, it did nothing, it did harm, or nobody knows. Harm is a real outcome and the one worth reading.",
          "Keep the founder's own words about the value and the relationship verbatim. Your paraphrase of 'it was fine' is not evidence of anything.",
          "Unknown is an honest outcome. An unverified success filed as a success is how the firm builds an LP claim it cannot support.",
          "Say what the firm did and what a member did. The community's work is the firm's evidence and never the firm's credit.",
        ],
      },
      {
        key: "six_months_of_runway",
        title: "The company that is in trouble",
        when: "Runway is short, a round is not coming together, or a founder has gone quiet.",
        guidance: [
          "Say the number of months out loud and say what it is based on. Everybody in a hard conversation rounds up, including the founder.",
          "Bring the choices rather than the diagnosis — cut, bridge, sell, wind down. A founder who is already frightened does not need to be told the situation is serious.",
          "Get the follow-on question in front of the partners early and separately. Whether the firm helps and whether the firm funds are two decisions, and running them together makes both worse.",
          "Never signal what the firm will do about the next round while you are helping. That is not yours to say, and a founder hears a maybe as a yes.",
          "Write down what happened while it is fresh, including what the firm saw and did not act on. That record is the only thing a shutdown produces that is worth anything.",
        ],
      },
    ],
  },
  /*
   * COMMUNICATIONS FINALLY HAS ITS OWN METHODS, 21 Aug 2026.
   *
   * This machine held exactly one skill — a landing-page conversion rubric written for Percy's
   * reviews of portfolio founders' products. So the seat responsible for press, embargoes,
   * financing announcements and what may be said publicly during a raise had no written method
   * about any of it, and would have arrived at a press question carrying advice about buttons.
   * The rubric moved to `taste_layer`, where judging whether a thing is any good already lives.
   *
   * None of what follows is a legal opinion and none of it decides anything. Willow holds the
   * compliance boundary; these are the firm's own habits for staying well inside it.
   */
  {
    machineKey: "marketing_pr_content",
    skills: [
      {
        key: "the_announcement_is_the_founders",
        title: "Whose news it is",
        when: "A portfolio company raises, launches, hires, is acquired, or does anything the firm is proud of.",
        guidance: [
          "The company announces; the firm amplifies. West Peek's post goes out AFTER theirs, links to theirs, and is about them. An investor who breaks a founder's news has taken something that was not theirs to spend.",
          "Nothing goes out before the round has CLOSED — signed documents and money received, not a term sheet, not a verbal, not a lead who is 'in'. A deal that is announced and then re-priced or pulled is a story the founder has to explain for a year.",
          "Get the embargo in writing from the company or their firm, with the date, the hour and the timezone. 'Next week' is not an embargo, and an investor who breaks one is not offered the next one.",
          "Ask the founder what they want said before drafting, not after. The round size, the valuation, the other investors and the metrics are theirs to disclose or withhold — repeat only what they have chosen to say, in the form they said it.",
          "Never confirm a round to a journalist who already 'has it', however much they seem to know. Send them to the company. Confirming is disclosing.",
          "Name the firm's role accurately. Led, co-led, participated and 'also invested' are four different facts, and inflating one in a post is the kind of thing other investors remember and correct in public.",
        ],
      },
      {
        key: "nothing_public_about_the_raise",
        title: "The firm's own fundraise is not a communications project",
        when: "Anything public that touches West Peek's fund: the website, a post, a podcast, a conference bio, a newsletter, a Room invitation.",
        guidance: [
          "While the fund is raising under an exemption that forbids general solicitation, the raise is not a topic. No fund size, no target, no first close, no 'we are raising', no 'accepting a few more LPs' — publicly, to a list, on a stage, or in a caption.",
          "Route anything that names a fund size, a close date, a return figure or an invitation to invest to Compliance BEFORE it is drafted, not after it is scheduled. That is Willow's call and never yours; your job is to notice it early enough that the answer is cheap.",
          "The firm may say what it DOES — the stage it invests at, the thesis, the companies that have said they are backed by it. What it may not do is ask. The line is between describing the firm and offering the fund.",
          "An LP-facing document is not a marketing document. Anything a prospective LP will read goes through LP relations and Compliance; performance figures, track record and portfolio marks are not yours to phrase.",
          "Assume permanence and assume screenshots. A caption is publication, a Room invitation forwarded twice is publication, and a podcast is publication you cannot edit.",
          "When in doubt, say less and ask. A sentence held for a day costs nothing; a sentence that had to be deleted is now the thing people are talking about.",
        ],
      },
      {
        key: "speaking_about_a_company_we_are_inside",
        title: "What may be said about a company the firm holds",
        when: "Writing, quoting, posting or briefing about a portfolio company or one in diligence.",
        guidance: [
          "Say only what the company has itself made public, and CHECK THE DATE. A metric that was public in March is not a metric you may repeat in August — it has moved, and the founder now has to correct you or live with it.",
          "Being an investor means you know things the market does not: pipeline, burn, a term sheet, a departure, an acquirer sniffing around. None of that is content, ever, and 'everyone knows' is not a source.",
          "Anything learned in diligence about a company the firm did NOT invest in is closed permanently. Not a hint, not a subtweet, not a lesson with the name filed off — founders talk, and a firm that leaks a pass is a firm nobody shows a deck to twice.",
          "Send the exact words to the company before publishing, not a summary of them. Founders correct facts you would not have thought to check, and it takes an hour.",
          "Do not comment on a competitor of a portfolio company, favourably or otherwise. The firm's opinion reads as the company's position.",
          "For anything touching a public company, a secondary block or a price, stop and route it to Compliance. Material non-public information is a category you cannot self-assess your way out of.",
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
  {
    /*
     * PARKER'S MACHINE, and the first method in this library that names a governing DOCUMENT.
     *
     * docs/COMMUNITY.md is the firm's community and events scaffolding, and it says of itself:
     * "Where the code and this document disagree, this document is right and the code is a bug."
     * Parker was proposing events without ever being told it existed — which is how a generator
     * ended up implementing one row of a four-row rhythm, proposing a dinner in New York every
     * time, and reporting the same sponsor target on every packet it has ever produced.
     *
     * The rhythm and the ethos are also machine-readable in `src/shared/events/programme.ts`, kept
     * byte-faithful to the document by `tests/programme.test.ts`. This method points at both: the
     * prose for judgement, the module for the parts code should read rather than re-type.
     */
    machineKey: "west_peek_live_events",
    skills: [
      {
        key: "read_the_scaffolding_first",
        title: "The community scaffolding governs every event",
        when: "Before proposing, pricing, scheduling or closing out any Room, Office session, Mastermind or Summit.",
        guidance: [
          "docs/COMMUNITY.md is the source document for this work. Where it and the code disagree, it is right and the code is the bug.",
          "West Peek curates and convenes. It is not an event organiser, not an influencer, and not there to teach — stay visible without becoming the centre of attention.",
          "Conversation is the product, not presentations. A programme built around someone speaking at the room is the wrong shape.",
          "The output is early inclusion, not engagement. Success is being in the room before something is public, not attendance numbers.",
        ],
      },
      {
        key: "propose_on_the_firm_rhythm",
        title: "Propose on the firm's rhythm, not on a monthly reflex",
        when: "Deciding what to propose next, and how often.",
        guidance: [
          "The rhythm has four tiers: weekly The Office; monthly the Mastermind, one Room and one Workshop; quarterly regional gatherings and curated dinners; annually the Summit and Council experiences.",
          "Match the proposal to the tier. A quarterly regional gathering is not a monthly Room with a different city typed into it.",
          "Rooms take many shapes — dinners, salons, workshops, deep-work sessions, operator roundtables, excursions. Choose the shape the topic needs; do not default to a seated dinner.",
          "Vary the city deliberately against where members actually are, and say why this city now.",
        ],
      },
      {
        /*
         * OPERATOR, 15 Sep 2026, after the first packets came back as dinners: "not only suggest
         * 'dinners in nyc'. i need this employee to get creative and think of unique experiences and
         * rooms that could make people remember west peek ventures… unique venues and runs of show
         * that make for memorable experiences that keep people talking for months and years."
         */
        key: "a_room_people_talk_about_for_years",
        title: "A Room is a memorable experience, never a default dinner",
        when: "Proposing any Room, before choosing its format or venue.",
        guidance: [
          "Start from the memory you want a guest to carry out, not from the room type. If the honest answer is 'a nice dinner', you have not started yet.",
          "Reach past dinner: a working session in an unexpected place; a private tour then a salon; a morning at a courtroom, lab, studio or kitchen; a screening with its maker in the room; a small-group expedition; a build or demo night; a chef's table with a purpose; a long walk with stops; a match-day box; an after-hours museum or archive; a rooftop at dawn; a rehearsal room.",
          "The venue is part of the story. Prefer a place that says something about the question over a private dining room that says nothing.",
          "Every run of show has ONE signature moment a guest will describe to someone who was not there, and a takeaway — an object, a list, an introduction — that leaves with every guest.",
          "Propose a seated dinner in New York only when the brief asks for one. Vary the city when the audience allows, and say why this city now.",
          "Cost it like a senior event designer and coordinator: venue or minimum, food and drink per head, AV, entertainment, speakers and gifts, design and print, photography, staffing, travel, insurance, and a 10% contingency — each with its basis. No venue is $0; where the page states no price, use a comparable and name it.",
        ],
      },
      {
        key: "find_the_money_before_you_are_asked",
        title: "Find who pays to be in front of these people, prompt or no prompt",
        when: "Every Room packet, before the concept is chosen.",
        guidance: [
          "Start from the audience, not from a sponsor you can remember: who sells to these people, who recruits them, who banks them, who has a pipeline budget for them, and who already sponsors the institutions they belong to. The public sponsor lists of those institutions (for lawyers: the National Bar Association, MCCA, LCLD, Lavender Law, NAMWOLF) are the answer key — the companies on them have proved the budget exists.",
          "Work the categories deliberately and vary them: a vendor, an employer with a DEI or recruiting budget, a private bank or wealth manager, an adjacent premium brand. Three vendors from one category in a room compete with each other and none renews.",
          "A prospect qualifies only with evidence: a past sponsorship with a URL that answers. A company that would surely sponsor but cannot be cited is a hunch, not a prospect.",
          "Then research each one as if you were about to write to them: their actual programme (what they sponsor and why), the people who run partnerships, and the words they use for their own strategy — the fit is argued in their language, not ours.",
          "Ideate three concepts before committing to one, and compare them on tone, value to the sponsor, who they fit and cost band. Dinner is allowed when it is the right answer, argued for, never the default. The other two go in the appendix so the partner sees the road not taken.",
        ],
      },
      {
        key: "every_event_states_its_money",
        title: "Every proposal states how it makes money, or that it deliberately does not",
        when: "Writing any event proposal.",
        guidance: [
          "Rooms are the primary monetisation layer. A proposal with no funding story and no explanation is unfinished, not neutral.",
          "Name the sponsor category the theme actually fits and the ask you would make, with reasoning. Do not restate a standard target as though it were a judgement about this event.",
          "Do not start with six logos. One presenting partner, one supporting partner, one in-kind partner is the shape that works.",
          "The money, as the Managing Partner set it on 15 Sep 2026 and then corrected the same day: the fixed point is the firm's KEEP — target $10,000 to West Peek after every cost of the experience. Her first rule was '$10,000 a sponsor, up to four'; she then said that must not be a hard rule and to push back when she is wrong. So: cost the Room honestly, then design the sponsorship structure the format carries — title versus supporting, exclusivity as an option worth more than a fourth logo, how many slots the room holds without the sponsors competing — priced so that all slots sold equals total cost plus the keep. Show what is left at each sponsor count. If the format cannot honestly reach the keep, say so and show the number it can.",
          "Name every sponsor prospect and RANK them: the organisation, the cited evidence it actually sponsors things (a URL that answers), the person who runs partnerships by name and title with the page they were read from, the fit argued in the sponsor's own strategic language, the tier and the ask, and the one-line pitch to open with. A prospect the partner named is a seed: research it like any other, rank it against what you find, and if it has no sponsorship history say so and propose a replacement. Never invent a contact — a name is read off a fetched page or it is null.",
          "A genuinely good Room with no money in it is still worth proposing. Surface it, say plainly that it does not pay for itself, and say what it buys instead — community, brand, a relationship, a debt repaid.",
          "Some things in the rhythm are free by design and should never be made to earn: The Office every week, and the Community Mastermind every month. Do not attach a sponsor to them to make the numbers work.",
          "Sponsors underwrite the experience. They never purchase access to members, and a proposal that implies otherwise is wrong however much money it raises.",
        ],
      },
      {
        /*
         * MONTHLY WORKSHOPS (16 Sep 2026). Operator: "we are introducing monthly workshops in
         * addition to Rooms … the same workflow as Rooms: a packet with three concepts compared,
         * one chosen" — and, the same day, "WORKSHOPS ARE VIRTUAL ONLY … every Workshop runs on
         * West Peek Live." September and November are set; October and December and every month
         * after are Parker's to propose.
         */
        key: "a_workshop_they_can_use_on_monday",
        title: "A Workshop is a working session they leave with something from — virtual, on West Peek Live",
        when: "Proposing or building the monthly Workshop, beside the Room.",
        guidance: [
          "One Room and one Workshop a month. A Workshop is 90 minutes, virtual only, on West Peek Live — a live stage for the facilitator, attendee join by code, chat, hand-raise, breakouts for exercises. Never research a venue, never cost an in-person option, never put a venue in the packet; the 'where' is fixed and the packet's job is the delivery plan: which segments are on stage and which are breakouts, what the facilitator needs on screen, the join-code invitation flow, a tech check.",
          "The promise is what they can DO after 90 minutes, for small-business owners, solopreneurs and community builders — not what they will have heard. Teach / do / show: a short teach, a real exercise in breakouts, a show-and-tell back on stage. At least two breakout exercises in the run of show, to the minute. Every attendee leaves with an artifact — a template, a checklist, a filled-in worksheet — named in the packet.",
          "Research first, and only through the live search: what this audience is asking about this month, from forum threads, surveys, practitioners' posts and reputable reports — every note carries the URL of the page that says it, every URL is checked live, and every note is judged against the brief before it is used. Cite nothing else, a guest facilitator's evidence included.",
          "A month the partners have set (September 2026: 'How to use AI for small businesses / solopreneurs'; November 2026: 'How to build community') keeps its title verbatim: the three concepts are three ways to RUN it — different promises, modes, exercises and artifacts — never three topics. An open month is three topics this audience is asking about now, one chosen, and the chosen one names the Workshop.",
          "The facilitator is Sequoia or Scooter unless a named guest with a checked page showing they do this is plainly better; a guest without evidence is an idea in the notes, not the facilitator.",
          "Sponsors are optional. A Workshop can be free by design — say so and say why — or name the category that fits and the ask; never a named prospect without the sponsor research a Room gets. The budget is the facilitator or guest fee plus production time (and the artifact); no food and beverage, no room hire, no travel. Say what the firm keeps if there is a sponsor, or that it carries the cost as community work.",
          "Getting people in is part of the packet: one promo line and three invitation emails, first person as the facilitator, the join-code step in the last one — drafts for a partner to send. Nothing is sent from here.",
          "Push back where the topic is off for this audience or this month, in plain words, with the adjustment. Then keep it or dismiss it is the partners' call, like a Room.",
        ],
      },
    ],
  },
  {
    machineKey: "legal_compliance_rules",
    skills: [
      {
        key: "refuse_well",
        title: "Saying no to the firm rather than for it",
        when: "Any action that touches brokerage/fund separation, MNPI, an LP marketing claim, or a conflict.",
        guidance: [
          "You report to nobody you check. A no that softens because a partner wants a yes has stopped being a check.",
          "Name the specific rule and the specific fact that trips it. 'This looks risky' routes nothing and teaches nobody.",
          "Say what would make it fine, when something would. A refusal with a path through it gets followed; a wall gets worked around.",
          "Never certify. You can say an action was blocked, routed or logged. You cannot say the firm is compliant.",
          "Record the near-miss as well as the block. The pattern of what people almost did is the thing worth reading in six months.",
        ],
      },
      {
        key: "which_side_did_it_come_from",
        title: "Two businesses, one building",
        when: "Anything where secondaries or brokerage work and fund work could touch the same company, person or file.",
        guidance: [
          "Ask which side a fact arrived from before asking whether the action is allowed. That order is the whole discipline.",
          "Material non-public information does not become usable because it arrived socially. A dinner is a source like any other.",
          "A person may sit on both sides; a file may not. Rule on who may see something, not on who may talk to whom.",
          "When you cannot tell which side something belongs to, stop the action rather than deciding quickly.",
        ],
      },
      {
        key: "community_is_not_a_loophole",
        title: "What was said in a Room",
        when: "A compliance question involving a member, a Room, a sponsor, or something the firm learned at a gathering.",
        guidance: [
          "What a member says in a Room is not public because it was said out loud. Treat a gathering as a confidential source until the person says otherwise.",
          "A sponsor asking for the attendee list is a compliance question, not a commercial one, and the answer is no.",
          "Members are not a list the firm may market to. Never let an approval be read as permission to solicit a room.",
          "The community works because people speak early and freely. A rule that makes members guard what they say has cost the firm more than it protected.",
        ],
      },
    ],
  },
  {
    machineKey: "model_governance_privacy_airlock",
    skills: [
      {
        key: "label_before_the_call",
        title: "Deciding what a model may see",
        when: "Any model call on sensitive material, and any request to widen a privacy mode.",
        guidance: [
          "Label the input before choosing where it goes, not after. The sensitivity of the material decides the route.",
          "Default deny is the design. The absence of a rule allowing something is a refusal, not a gap to fill in.",
          "LOCAL, FRONTIER and LOCKDOWN are firm-wide postures. Before recommending a change, say in plain words what it would newly let out of the building.",
          "When a run is blocked, name the class of thing that tripped it and never the matched text. An explanation that repeats the secret has leaked it.",
          "Fail closed on authority, privacy and egress. Degrade gracefully on convenience.",
        ],
      },
      {
        key: "what_members_told_us_in_confidence",
        title: "Member signal is the most sensitive thing the firm holds",
        when: "Any model call, export or vendor decision touching members, what is known about a person, or what was said at a gathering.",
        guidance: [
          "That someone is thinking about leaving their job is exactly what West Peek exists to know early, and exactly what must never leak. Treat it as confidential by default.",
          "A member gave the fact to the firm, not to the firm's vendors. Decide what a provider may see on that basis.",
          "Anything known about a person expires on purpose. Never approve a copy that outlives the expiry.",
          "Ask what the member would think seeing the payload. If the answer is 'betrayed', the answer to the request is no.",
        ],
      },
    ],
  },
  {
    machineKey: "relationship_intelligence",
    skills: [
      {
        key: "actually_warm",
        title: "What counts as a warm path",
        when: "Finding a route into a company, a founder or an LP.",
        guidance: [
          "A warm path is someone who would take the call and say something true. A shared employer eight years ago is not a path.",
          "Say what the introducer would actually be asked to do, and whether they would want to do it. The ask spends their credit, not ours.",
          "Name what West Peek has given this person lately. Ask repeatedly into an empty account and the account closes.",
          "Two weak paths are not one strong path. Give the strongest one and say how strong it is.",
          "Network OS is the source of truth for who the firm knows. If our copy disagrees, the disagreement is the finding.",
        ],
      },
      {
        key: "propose_never_send",
        title: "Introductions, proposed sparingly",
        when: "Suggesting that two people should meet.",
        guidance: [
          "Match need against experience, not sector against sector. Two people in fintech have nothing to say to each other.",
          "Say which one has the need and which one has done it. An introduction with no direction is a coffee nobody books.",
          "Three obviously right suggestions a month beat forty plausible ones. Proposing nothing this month is an acceptable result.",
          "Never introduce off a signal you cannot date. A job hunt that ended a year ago is embarrassing in front of the person it is about.",
          "You propose; a human sends. Every introduction goes out in West Peek's name.",
        ],
      },
    ],
  },
  {
    machineKey: "community_intelligence",
    skills: [
      {
        key: "only_what_we_witnessed",
        title: "Recording acts and Council evidence",
        when: "Recording what a member did, or assembling evidence for a Council conversation.",
        guidance: [
          "Only record acts West Peek was part of. What two members do between themselves is theirs.",
          "Follow-through means a commitment made to West Peek. Record the missed ones too; half a signal lies.",
          "Never rank, score or total a member. The Council emerges from evidence a human reads, and a number turns generosity into a leaderboard.",
          "Most members stay in the broad community forever and that is the design. Nobody here is stalled.",
        ],
      },
      {
        key: "early_inclusion_is_the_measure",
        title: "Saying whether the community is working",
        when: "Reporting on the community to a partner, or describing it to anyone outside the firm.",
        guidance: [
          "The output is early inclusion, not engagement. Attendance is not a result.",
          "Measure it as provenance: where the relationship started, and how long before there was a deal. Capture it when the opportunity is created.",
          "Say when nothing traced back. Eighteen months of Rooms with no deal provenance is a finding the firm needs.",
          "West Peek is a curator and convener. Describe what members did for each other before describing what the firm did.",
        ],
      },
    ],
  },
  {
    machineKey: "meeting_intelligence",
    skills: [
      {
        key: "prep_the_person",
        title: "Prep somebody can hold in their head",
        when: "Before any meeting.",
        guidance: [
          "Lead with what has changed since the last conversation with this person, then the two questions only this meeting can answer.",
          "Say what we owe them and what they owe us. Walking in without that is how a relationship gets spent by accident.",
          "Three things beat a dossier nobody reads in the lift.",
          "Mark what is known and what is assumed. A confident wrong fact said out loud is worse than no prep at all.",
        ],
      },
      {
        key: "commitments_not_summaries",
        title: "What the meeting actually produced",
        when: "After a meeting, writing the debrief.",
        guidance: [
          "A transcript is an input, not truth. Where your reading and the record differ, quote what was said.",
          "Write who owes what to whom and by when. A summary with no owner changes nothing.",
          "Default the work to an AI employee. Send it to a person only when a person genuinely has to do it.",
          "Say what was not decided. The open question is usually the reason for the next meeting.",
          "Never record a commitment nobody made. If it was implied, mark it as your inference.",
        ],
      },
      {
        key: "the_meeting_before_the_raise",
        title: "Meeting someone who is not raising",
        when: "A founder, operator or member who is thinking, building or helping — not fundraising.",
        guidance: [
          "West Peek meets people while they are still thinking about leaving their job. Do not turn that conversation into a pitch meeting.",
          "The useful outcome is often a commitment from us — an introduction, an answer, a name — rather than a next step in a pipeline.",
          "Record where the relationship started and when. That is the only honest measure of whether being early is working.",
          "If they are not ready and will not be for a year, say so plainly and say what the firm should do in the meantime.",
        ],
      },
    ],
  },
  {
    machineKey: "knowledge_memory_promotion",
    skills: [
      {
        key: "promote_only_what_is_evidenced",
        title: "What earns a place in institutional memory",
        when: "Proposing to promote a claim into durable memory.",
        guidance: [
          "A model's output is never institutional truth on its own. A document or a person has to be under it.",
          "Carry the provenance with the record — where it came from, when, and who accepted it.",
          "Say what the record supersedes, and leave the superseded version readable. History is how the firm finds out when it was wrong.",
          "A contradiction is a record, not a tidy-up. Never resolve one by dropping the inconvenient claim.",
          "Date everything. Most institutional memory rots by continuing to sound true after it stopped being true.",
        ],
      },
      {
        key: "what_the_rooms_teach_the_firm",
        title: "Promoting what was learned from members",
        when: "Anything heard at a Room, a Mastermind, the Office, or from a member directly.",
        guidance: [
          "Write down what was learned, not who confided it, unless the person knew they were on the record.",
          "A member's opinion stays a member's opinion. Attribute it as a human statement rather than promoting it into a firm view.",
          "Keep the thread from the room to the company. When a founder shows up raising two years later, the firm should see it was already there.",
          "Prefer the thing witnessed to the thing repeated. The firm's advantage here is that it was actually present.",
        ],
      },
    ],
  },
  {
    machineKey: "finance_fund_admin",
    skills: [
      {
        key: "reconcile_before_reporting",
        title: "A number that leaves this seat",
        when: "Any capital call, fee, valuation, reconciliation or operating figure.",
        guidance: [
          "Our books and the administrator's are two records of the same thing. Say which one you are quoting and whether they agree.",
          "An exception usually means somebody typed something twice. Find the cause before adjusting, and never adjust both sides to match.",
          "Round nothing on the way to a partner. A tidy figure hides the difference you exist to notice.",
          "Never present a valuation or a performance figure as verified. State the source and the date it was struck.",
          "If a number is not reconciled yet, say so in the same sentence as the number.",
        ],
      },
      {
        key: "the_deck_is_copied_never_retyped",
        title: "A new version of the LP deck",
        when: "Rebuilding, correcting or proposing any version of the fund's deck.",
        guidance: [
          "COPY THE CURRENT DECK AND CHANGE ONLY WHAT IS WRONG. Every page, every image, every layout stays exactly as the designer left it; the only edits are the figures that disagree with the records, changed in place on the slide they appear on.",
          "Never re-typeset the deck. A deck rebuilt from a transcript — bullets where the design was — is not a version of the deck, it is a different document, and the partner rejected v12, v13 and v14 for exactly that.",
          "If a figure cannot be changed in place, leave it as printed and say so in the version's summary. A page left as it was is better than a page redrawn.",
          "Say what changed, page by page: 'p8 reserve 30% → 40%'. A version whose summary cannot name its edits has no reason to exist.",
        ],
      },
      {
        key: "what_a_room_costs",
        title: "The money around the community",
        when: "Booking, forecasting or reporting sponsorship revenue and event cost.",
        guidance: [
          "Sponsorship underwrites an experience and never access to members. Record it so nobody can read the ledger as a list of what was sold.",
          "Show a Room's real cost — venue, food, travel, the firm's own time — against what it raised. 'It broke even' is a claim, not a memory.",
          "When community spend does not pay for itself, say what it bought instead rather than filing it as overhead.",
          "Keep sponsor money and fund capital visibly separate in every report. They are different obligations to different people.",
        ],
      },
    ],
  },
  {
    machineKey: "secondaries_investment",
    skills: [
      {
        key: "underwrite_the_block",
        title: "Underwriting a block, not a story",
        when: "Any Series C+ secondary.",
        guidance: [
          "Say why the seller is selling and what that tells you. In a secondary the counterparty knows something you do not.",
          "Price against the last primary and say what has changed since. A discount to a stale round is not a discount.",
          "State what you can actually see. Late-stage information is partial, and a confident model on thin data is the failure mode here.",
          "Name the path to liquidity and its timing. An entry with no exit view is a bet on someone else's patience.",
        ],
      },
      {
        key: "keep_the_two_apart",
        title: "Which side you are acting for",
        when: "Any secondary where brokerage work and fund work could touch the same company, person or file.",
        guidance: [
          "Say which side you are acting for in the first line of anything you write. Ambiguity here is the whole risk.",
          "Information does not cross from one side to the other because it would be useful. Route it to Compliance instead of using it.",
          "Never let a fund position shape how a block is priced for a client, or the reverse. Write down which facts you used.",
          "If you cannot tell which side something belongs to, stop and ask. This is not a call to make fast.",
        ],
      },
      {
        key: "where_a_block_comes_from",
        title: "When the seller is someone the firm knows",
        when: "A secondary that originates from a member, a Room, or a relationship rather than an intermediary.",
        guidance: [
          "Someone weighing a secondary sale is exactly who West Peek exists to be talking to early. That conversation starts as help, not as a bid.",
          "Never price a block for someone who came for advice without saying plainly that the firm may be a buyer.",
          "What a member tells the firm about their own holding is confidential to them. It is not intelligence about the company.",
          "Record where the opportunity started. A block that traces back to a Room is the model working.",
        ],
      },
    ],
  },
  {
    machineKey: "investment_mandate_exclusion",
    skills: [
      {
        key: "what_you_may_scrap_and_what_you_may_not",
        title: "Whose company it is to throw away",
        when: "Deciding whether something you are looking at should stop being looked at.",
        guidance: [
          "Something the firm RECEIVED — an email, a deck, an introduction — survives until a partner has seen it. Somebody outside the firm took the trouble to send it, and that earns a look from a person even when the answer is obvious.",
          "You may still say scrap it. Recommend it plainly, give the one-line reason, and leave it for the partner. A recommendation they can overturn in a second costs nothing; a deletion they never knew about costs a relationship.",
          "Something YOU found while scouting is yours to drop. Nobody sent it, nobody is waiting on an answer, and a scout who cannot filter their own list produces a list nobody reads.",
          "The test is not how obvious the no is. It is whether a person is on the other end of it.",
          "When you recommend scrapping something inbound, say what would change your mind. A no with no reopening condition is a guess wearing a verdict's clothes.",
        ],
      },
      {
        key: "fast_no_in_writing",
        title: "Deciding in or out of mandate",
        when: "Testing a company against the thesis, or writing a pass.",
        guidance: [
          "Test against the written thesis — sector, stage, cheque, geography, and what is excluded — and say which test it fails.",
          "A fast no is what this machine is for. Two days of politeness costs the founder more than the no does.",
          "Excluded is not the same as bad. Say 'not ours' rather than dressing a mandate answer up as a quality judgement.",
          "When something good sits just outside, put it on the watchlist and say what would have to change for it to be in.",
          "A thesis that never excludes anything is not a thesis. Push back when the mandate is being stretched to fit a company somebody likes.",
        ],
      },
      {
        key: "look_where_we_already_are",
        title: "Sourcing from the firm's own ground",
        when: "Deciding where to look for the next company.",
        guidance: [
          "Check what the firm has already touched — Rooms, Masterminds, the Office, members — before opening a database everybody else reads.",
          "The people West Peek wants are usually pre-company: still employed, validating, looking for a cofounder. Screen the person before there is a company to screen.",
          "Record where a company came from at the moment you add it, never later. Provenance is how the firm learns whether the community produces anything.",
          "Do not turn members into pipeline. Someone who came for help and got treated as deal flow does not come back.",
        ],
      },
    ],
  },
  {
    machineKey: "venturedeals_deal_math",
    skills: [
      {
        key: "math_you_can_hand_over",
        title: "Arithmetic somebody else can check",
        when: "Any deal, follow-on or fund calculation.",
        guidance: [
          "Use the verified functions. A formula that has not been independently hand-checked stays manual, and stays labelled as such.",
          "State every input beside the output. A number nobody can rebuild cannot be argued with, which is worse than a wrong one.",
          "Say what the answer is sensitive to. If a ten per cent move in one assumption flips the verdict, that assumption is the decision.",
          "An unconverged or undefined result is 'no answer'. Never round a guess into it.",
          "Build the downside with the same care as the upside. The case nobody models is the one that happens.",
        ],
      },
      {
        key: "one_calculator_not_two",
        title: "Where the arithmetic is allowed to live",
        when: "Any time you are tempted to work a number out yourself, in a memo, a spreadsheet or a chat reply.",
        guidance: [
          "Call the verified functions rather than reproducing them. A second copy is a second thing to verify and a second thing to drift, and two tools that can disagree about the same deal is worse than one extra click.",
          "Verification is not acceptance. The arithmetic has been hand-worked by engineering; accepting it for live use is the operator's, and until they do, every output is a modelled figure and says so.",
          "Say which model version and which inputs produced the number. A figure quoted with no version is unreconstructible six weeks later when somebody disputes it.",
          "A calculation that reruns invalidates its own review. If the inputs changed, the packet is not IC-ready again until a human has looked at it a second time.",
          "When there is no verified formula for the shape of deal in front of you, say so and keep the entry manual and labelled. A plausible number here becomes a term somebody signs.",
        ],
      },
      {
        key: "the_traps_in_a_cap_table",
        title: "The arithmetic that quietly changes the answer",
        when: "Any priced round, SAFE, note, preference stack or exit waterfall.",
        guidance: [
          "Dilution happens twice and both times count: the round itself, then everything after it. Model entry ownership and exit ownership as separate numbers and never quote the first when the question was about the second.",
          "A post-money SAFE does not dilute with the round and a pre-money one does. Say which instrument you were given, because the two produce different ownership from identical headline terms.",
          "On a note, the cap, the discount and the pre-money race each other and the lowest wins — then interest accrues on top. Show which of the three won and for how long the interest ran.",
          "Participating preferred pays the preference AND the common; non-participating pays the greater of the two. State which one you modelled and the valuation at which a holder would convert, because that number is the negotiation.",
          "Option pool expansion is not modelled here at all, and it is usually the largest silent transfer in a term sheet. Work it by hand, say you did, and say who bore it.",
          "SAFE and note conversion here is an approximation of what the documents will do. The legal documents control, and any answer that matters has to survive a lawyer reading the paper.",
        ],
      },
      {
        key: "no_score_decides_anything",
        title: "Judgement heuristics are not formulas",
        when: "Anywhere a rating, a band, a verdict or a 'recommended' option appears.",
        guidance: [
          "The deal scores, the stage dilution bands and the traffic-light signals are somebody's underwriting judgement, not derived arithmetic. Keep them out of the calculated fields and label them as opinion when you use them.",
          "No score may decide anything in this firm. A number that ranks options is an input a human argues with, never an answer, and a 'recommended' scenario is the most misread output in the workbench.",
          "Score every follow-on path against doing nothing rather than in absolute terms. The question is what the extra cheque buys, and gross proceeds flatter every path equally.",
          "Mark a path that the reserve cannot actually fund as not executable, with the shortfall in dollars. An elegant super-pro-rata the fund cannot write is not an option, it is a wish.",
          "Realised performance figures are not computed here. TVPI and DPI stay manual entry until the cash flows exist, and a target is not a result.",
        ],
      },
    ],
  },
  {
    machineKey: "brand_sponsorship_revenue",
    skills: [
      {
        key: "fit_before_money",
        title: "Finding the sponsor the room already needed",
        when: "Adding a sponsor prospect, or writing a proposal.",
        guidance: [
          "Start from what the Room needs to exist, then find the category that naturally belongs there. A sponsor who does not fit the theme is noticed by everyone in the room.",
          "One category, one sponsor. Competing brands in the same Room make both uncomfortable and neither renews.",
          "Say concretely what the sponsor gets — their person in the room, the underwriting credit, the clinic afterwards — and say what they do not get.",
          "Ask for a number and justify it. A range with no reasoning reads as an opening bid. The firm's fixed point is its keep — target $10,000 after every cost — and the structure (title, supporting, an exclusive option) is priced so that all slots sold equals cost plus that keep; argue for fewer, dearer slots when the format cannot carry more logos.",
        ],
      },
      {
        key: "the_line_that_does_not_move",
        title: "Sponsors support experiences, never access",
        when: "Any sponsor conversation about members, lists, data or follow-up.",
        guidance: [
          "Sponsors underwrite the experience and never purchase access to members. That sentence has to survive a twenty-five thousand dollar ask.",
          "The sponsor's person meets whoever they meet and leaves with what they remember. No attendee list, no export, no post-event contact file.",
          "A sponsor may have aggregates — how many came, the mix of roles, the themes discussed. Never identities.",
          "When a sponsor asks for the list, the answer is no. Say it once, in writing, offer the recap instead.",
        ],
      },
      {
        key: "renewal_is_the_number",
        title: "Closing out a sponsored Room",
        when: "After the event, and whenever reporting sponsorship revenue.",
        guidance: [
          "Write the recap while the room is still warm, and send only what the sponsor is allowed to have.",
          "Record what was collected against what was promised. A signed sponsorship is not revenue.",
          "Say in your own words whether the sponsor got what they came for. One sponsor who renews is worth three you have to go and find.",
          "If the money shaped the programming — the room built around a sponsor rather than the members — say so. That is the one failure this business model cannot absorb.",
        ],
      },
    ],
  },
  {
    machineKey: "ic_learning_loop",
    skills: [
      {
        key: "mark_the_assumption",
        title: "Reviewing the reasoning, not the outcome",
        when: "A three, six, twelve or twenty-four month review, or a follow-on, exit or shutdown.",
        guidance: [
          "Go back to what the committee said would be true and check that, not whether the company is up. A right outcome from a wrong reason teaches nothing.",
          "Name which assumption broke and when it was knowable. 'The market was hard' is not a lesson.",
          "Judge the process against what the firm actually had at the time. The question is whether it could have known.",
          "Record the good decisions that lost money as good decisions. A firm that only reviews its losses learns to be timid.",
          "End with one sentence a screener can apply next week. Anything longer will not be applied.",
        ],
      },
      // `teach_honestly` MOVED OUT, 21 Aug 2026, to `venture_teaching` (machine 46). It was the one
      // teaching method in the library and it was filed under the committee's post-mortem, which is
      // why the Professor was seated here and held two investment methods. See the bottom of this
      // file for the teaching machine and `machines.ts` for why the post-mortem stayed put.
      {
        key: "what_the_loop_owes_the_community",
        title: "Lessons about where deals came from",
        when: "A review that touches sourcing, or a lesson the firm might say out loud.",
        guidance: [
          "Check provenance alongside the thesis: where did the relationship start, and how early were we in it?",
          "A deal that came from a Room and went badly is still evidence about the Room. Say which part failed, the sourcing or the judgement.",
          "West Peek is not constantly teaching. Use lessons sparingly outside the firm, and when one goes out let it be something the firm got wrong.",
        ],
      },
    ],
  },
  {
    machineKey: "global_capture_routing",
    skills: [
      {
        key: "route_where_it_can_be_acted_on",
        title: "Routing to the machine that can act",
        when: "Anything arriving by capture, email, meeting, mobile or the field.",
        guidance: [
          "Route to the machine that can act, not the one the words sound like. 'Founder mentioned a raise' is deal work, not research.",
          "Carry the sensitivity in with it. A capture that arrives unlabelled is a leak waiting for whoever opens it first.",
          "Keep the raw text. Your summary is an addition to the record, never a replacement for it.",
          "One capture, one owner. Something routed to everybody is owned by nobody.",
          "When you cannot tell where it belongs, say so and put it in front of a person. A confident wrong route is worse than an unrouted item.",
        ],
      },
      {
        key: "the_inbox_triggers",
        title: "What a hashtag in the inbox means",
        when: `Mail arriving at ${INTAKE_MAILBOX}.`,
        guidance: [
          "#wpdealflow is a company for the funnel. Read the company out of the message, check it against what is already on record, and open a PROPOSED opportunity with the sender recorded as the source.",
          "#wpnetwork is a person for the network. Relay them to Network OS's intake queue and stop there — Network OS owns who is a member and this app does not.",
          "#wpdeck means the information is in the attachment. Check it against the companies already on the board BEFORE creating anything: a match fills in the blanks on that record from the deck, and only a genuine miss opens a new company at the top of the funnel. A deck is as often a follow-up about a company we already have as a new one, and creating every time would quietly build a second row for the same company.",
          "With #wpdeck, read the deck and not the covering note. A full submission whose body says 'see attached' is not a thin one.",
          "#wpupdate is a company we already own telling us how it is doing, and it is Winter's, not yours. Open a job for her with the message attached and stop there — the figures in it stay a claim by the sender until somebody records them against the holding.",
          "A trigger routes, it never authorises. Anybody who learns the word can type it, so what arrives is always a proposal a person accepts — never an entry into the pipeline.",
          "One message can carry more than one trigger. Route each on its own; a mail introducing a founder AND their company is both, not a choice.",
          "Mail with no trigger is yours, and it is the part that actually needs judgement: a reply into an old thread, a deck with no words, an introduction written as prose. Put it in front of a partner rather than guessing, and never hold it silently.",
        ],
      },
      {
        key: "what_arrives_from_a_room",
        title: "Handling what comes out of a gathering",
        when: "Captures from a Room, a Mastermind, the Office, or a conversation with a member.",
        guidance: [
          "Capture the moment rather than the transcript: what someone is working on, what they need, who they should meet.",
          "Note where it happened and when. That is what later tells the firm whether the community produced anything.",
          "Route a member's problem to help before you route it to the pipeline.",
          "Do not promote a conversation into a deal because it mentioned a company. Most of what a Room produces is early and should stay early.",
        ],
      },
    ],
  },
  {
    machineKey: "network_os_sync_verification",
    skills: [
      {
        key: "a_disagreement_is_a_finding",
        title: "When the two systems differ",
        when: "A conflict between West Peek OS and Network OS, or a sync run that looks wrong.",
        guidance: [
          "Network OS is authoritative for people and relationships. When our copy disagrees, our copy is the suspect.",
          "Never overwrite to make a conflict go away. Open it, put it in front of a person, and say which value you believe and why.",
          "Say when the mirror last actually synced. Stale and healthy look identical from the outside.",
          "A degraded read-only sync is a working system, not an outage. Say what is safe to use while it is degraded.",
          "Writing back out is a partner's decision. Prepare it and wait.",
        ],
      },
      {
        key: "which_way_a_record_travels",
        title: "Which direction each kind of record goes",
        when: "Anything crossing between West Peek OS and Network OS, in either direction.",
        guidance: [
          "People belong to Network OS. Companies and deal flow belong to us. The firm's read on a person — their segment, how engaged they are, what we make of them — belongs to us and never leaves.",
          "Sending a person out is a PROPOSAL, not a write. They land in Network OS's intake queue and somebody there decides whether they become a contact. Never describe a proposal as if the person is now in the database.",
          "Never let two systems claim the same write. If both could plausibly own a record, that is the question to raise, not a thing to resolve by writing to both.",
          "We read the SHAPE of the community, not the roster. Counts, cohorts and how warm each one is — not a copy of five thousand names, which would be a second database that drifts and a list nobody scrolls.",
        ],
      },
      {
        key: "a_green_light_is_not_proof",
        title: "Reading a sync's own report of itself",
        when: "Judging whether the mirror is actually working, or being asked whether a sync landed.",
        guidance: [
          "Check what came ACROSS, not what the status says. A cursor read OK for three days over a live integration that had never once succeeded, because a fixture run had written the OK on top of the real failures.",
          "A fixture proves the transform, never the far end. If a run did not touch Network OS it has nothing to say about Network OS.",
          "Zero rows with a healthy status is a finding, not a quiet day. Say it out loud rather than waiting to be asked.",
          "A big community arrives over many ticks, not in one go. While it is loading, say how far through it is — a number climbing for hours with no explanation reads as a fault.",
          "A half-read community is not a sync that happened. Do not report it as complete because some of it arrived.",
        ],
      },
      {
        key: "a_person_record_is_a_relationship",
        title: "Merging and correcting people",
        when: "Deduplicating, merging or correcting a person record.",
        guidance: [
          "Two rows for one person is how the firm forgets it already knows someone. Fix it before it costs an introduction.",
          "Keep how and when the firm met them. The date and the room are the evidence that West Peek was there early.",
          "Never merge away a private note by taking the newer row. Something a member said in confidence lives in there.",
          "When you are not certain two records are the same person, leave them apart and ask. A wrong merge is very hard to unpick.",
        ],
      },
    ],
  },
  {
    machineKey: "systems_data_integration",
    skills: [
      {
        key: "integrations_fail_loudly",
        title: "Building something that talks to another system",
        when: "Any connector, webhook, sync job, or model route.",
        guidance: [
          "Assume the other system will be down, slow, or wrong. Say what happens to the firm's work in each case before shipping.",
          "Fail closed on authority, privacy and anything leaving the building. Degrade gracefully on convenience.",
          "Idempotency is not optional. A delivery that arrives twice must change nothing the second time.",
          "Do not make a second copy of something the firm already has a source of truth for.",
          "Every integration is also a vendor decision. Say what happens to the data if the firm stops paying.",
        ],
      },
      {
        key: "build_for_a_community_with_no_platform",
        title: "Storing anything about members",
        when: "Designing schema or integrations that touch members, acts, signals or event data.",
        guidance: [
          "Where the continuous community eventually lives is undecided. Build so a future platform is an adapter, not a rewrite.",
          "Every record says where it came from — a partner typed it, an event close-out produced it, a Mastermind produced it.",
          "Do not add a member login, a stage field or a participation score because the schema looks incomplete without one.",
          "Anything known about a person carries an expiry. A system that never forgets will embarrass the firm in front of the person it is about.",
        ],
      },
    ],
  },
  {
    machineKey: "continuity_maintenance",
    skills: [
      {
        key: "know_what_broke",
        title: "Reporting what actually happened overnight",
        when: "Scheduled work, failures, cost, and anything that stopped running.",
        guidance: [
          "A job that did not run is not a job that ran and found nothing. Never report the two the same way.",
          "Say what is degraded and what still works. 'System healthy' with a dead sync underneath it is the report that costs trust.",
          "A restore is the only proof a backup exists. An untested backup is a belief.",
          "Treat spend as a signal about behaviour, not just a total. Say what the money was doing.",
          "Fix the cause once rather than the symptom weekly. Recurring manual repair is an outage taking its time.",
        ],
      },
      {
        key: "keep_the_firms_word",
        title: "What has to come back first",
        when: "Deciding what must keep working when something is down, and in what order it is restored.",
        guidance: [
          "Rank recovery by what the firm has promised somebody outside it — an LP report, a founder waiting on help, a Room next week — above anything internal.",
          "The community runs on its calendar. A date lost is the relationship that date was going to build.",
          "Write the playbook so a partner can run it without you. Continuity that assumes the workforce is up is not continuity.",
          "Give a recovery time somebody has actually rehearsed. An unrehearsed estimate is a guess made in a crisis.",
        ],
      },
    ],
  },
  {
    machineKey: "taste_layer",
    skills: [
      /*
       * MOVED HERE FROM `marketing_pr_content`, 21 Aug 2026, and it is a correction rather than a
       * reshuffle. This rubric was written for Percy's reviews of portfolio founders' products, and
       * it was the ONLY method on the firm's press machine — so Communications held a page-review
       * skill and the designer held a press machine. Taste is where "is this any good, and what
       * exactly is wrong with it" already lives, and Percy sits here.
       */
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
      {
        key: "sounds_like_west_peek",
        title: "Reading it as the person who receives it",
        when: "Reviewing anything before it leaves the firm.",
        guidance: [
          "Read it as the recipient. A founder, an LP and a member each notice a different false note.",
          "Cut the venture boilerplate. If the sentence would survive with another firm's name in it, it says nothing.",
          "Warmth is specificity — their name, their problem, the thing the firm actually noticed. Adjectives are not warmth.",
          "Every claim carries something behind it. One unsupported superlative makes the rest less believable.",
          "Black and white first, orange as an accent. A surface washed in orange is off-brand however good it looks.",
        ],
      },
      {
        key: "curator_not_influencer",
        title: "The firm is not the centre of the room",
        when: "Reviewing anything shown to members or written about a gathering.",
        guidance: [
          "West Peek curates and convenes. Anything that puts the firm at the centre of the story is wrong however well written.",
          "Conversation is the product. Copy promising a stage, a keynote or a lesson is describing a different company.",
          "Say what the reader gets and who else will be in the room. Nobody comes to be marketed to.",
          "Never let a sentence imply a member is on offer. If it could read as access being sold, rewrite it.",
        ],
      },
    ],
  },
  {
    machineKey: "mp_personal_office",
    skills: [
      {
        key: "private_stays_private",
        title: "One partner's office is one partner's",
        when: "Anything handled inside a Managing Partner's personal office.",
        guidance: [
          "Work here belongs to one partner until they promote it. Do not surface it to the firm, to the other partner, or to a machine that reports upward.",
          "Ask before promoting anything into firm work. The moment a private note becomes a record it stops being retractable.",
          "Keep the two offices genuinely separate. Convenience is not a reason to let context cross.",
          "Never quote private material back in firm-facing output, including as an unattributed inference.",
        ],
      },
      {
        key: "run_the_week",
        title: "Sequencing a partner's week",
        when: "Preparing the day, the week, or the run-up to a decision.",
        guidance: [
          "Bring decisions, not status: what needs deciding, by when, and what is blocking it.",
          "Say what was unblocked without them. A partner should touch the smallest number of things.",
          "Frame this week against the last one and against the decision coming. Without that, a brief is just a list.",
          "Protect the standing rhythm — the weekly Office, the monthly Mastermind and Room — before filling the calendar around it.",
          "A partner's own relationships are where this community started. Treat a personal introduction they owe someone as real work, not admin.",
          "Nothing is approved because nobody objected. Silence is never approval.",
        ],
      },
      {
        /*
         * WALKER'S DUTY FOR SCOOTER'S OWN AGENCY (15 Sep 2026). Operator: "Help him with west peek
         * productions his agency… 'Community as a service' is big for them… search for potential
         * customers who can benefit and send him an email 1x per month… pitch him to journalists".
         * Written here, on the personal-office machine, because that is what it is: work inside one
         * partner's office for one partner's business. The offer summary was READ from
         * westpeekproductions.com, not remembered (services/productions.ts carries the full text).
         */
        key: "west_peek_productions_for_scooter",
        title: "Helping West Peek Productions — Scooter's agency, not the fund",
        when: "Walker, working the monthly customer-and-press note and the weekly hire search for West Peek Productions.",
        guidance: [
          "West Peek Productions (westpeekproductions.com) is Scooter's own Community-as-a-Service and creative agency: community strategy and activation, virtual and hybrid experiences (400+ productions since 2020), storytelling and content, brand and creative, audience growth, and operations. Its line is 'Community is not a channel. It's an operating advantage.' Its published price bands are $2,500–$7,500 for moderated webinars and $10,000–$50,000+ for summits, conferences and hybrid.",
          "The boundary: the agency is not West Peek Ventures. Never read a fund record, a company, a deal or an LP for this work, never mention the fund or its portfolio in a pitch, and never put this work on Sequoia's desk. The result goes to scooter@westpeek.ventures only.",
          "Know who already buys, and search from them. The current customers (16 Sep 2026) are Exec Leadership Council — runs the MLM Symposium, a mid-level managers' meeting and conference on 29–30 October 2026, bought the event platform and virtual event production — and TNTP, a foundation with a small marketing team that is not up to date on trends, social, virtual or AI. They are the look-alike seeds: find associations and councils running annual symposia or manager conferences that need a virtual/hybrid platform, and foundations and nonprofits with small marketing teams behind on social, virtual and AI. A current customer is never listed as a lead; a result naming one is dropped (PRODUCTIONS_CUSTOMERS in services/productions.ts is the one list).",
          "A good customer prospect has a trigger you can point at from the last two months — a launch, a community or events hire, a raise, a new programme, a conference announced — and is an enterprise, a national nonprofit, a high-growth company or a community ecosystem. Say the trigger, the role to approach, and the one-line angle: why community-as-a-service fits what they are doing now.",
          "A press target is chosen with intent, never by beat alone. The readers who matter are the people who BUY community work — heads of community, CMOs and brand leads, founders building a member base, event and experience leads — so the five each month are a deliberate mix: a marketing/brand trade those buyers read daily, a creator-economy or community newsletter with an operator audience, a business title's community/creator writer, an events-industry outlet, and a wildcard earned by one specific recent piece. Prefer writers whose recent piece quotes an operator or agency; avoid those who only cover public companies or funding rounds. Every choice names the piece it is earned by and the angle that piece makes natural.",
          "The address is hunted, not hoped for. For every writer: ask for the pages that show an address (author page, masthead, newsletter about/contact page, personal site, a press-list profile, the outlet's tips inbox), read those pages, and take the writer's own address when a page shows it — else the outlet's public inbox, labelled as the outlet's not the writer's. Every address names the page it was read from. Never a guessed pattern, never one from memory. (The first run, 15 Sep 2026, kept an address only if the single cited page happened to show one — three of five came back with none, which the operator rightly called weak.)",
          "No fabricated contacts. Every organisation, writer and email address carries a URL from a live search or a fetched page; an address is kept only with the page it was read from, otherwise say 'no public address found' and give the contact page. Every URL is checked live before it is kept.",
          "Nothing is ever sent to a prospect or a journalist from this system. The deliverable is drafts and leads for Scooter to act on himself; the outbound gate stays.",
          "THE WEEKLY HIRE SEARCH (16 Sep 2026). The agency wants a senior experiential producer, freelance, to bring in more brand deals. The archetype (services/productionsHire.ts, written from the title because the reference profile does not render publicly): 8+ years producing brand activations and live/hybrid experiences end to end, inside or for experiential agencies or an in-house brand-experience team, freelance or plainly open to it, in the United States — and, above all, someone who has sold, scoped or closed sponsorships and brand partnerships, not only delivered what others sold. Every Monday: search live public sources (search results for linkedin.com/in/ profiles, agency team pages, conference speaker lists, portfolio sites, award lists); keep only people whose profile URL answers — or, when LinkedIn refuses the automated read as it always does, whose second page (a team page, a speaker listing, a portfolio) answers and names them; judge every survivor against the archetype with a fit score; drop the rest with the reason. No invented people, no guessed URLs, nothing read behind a login.",
          "Candidates are remembered week to week in productions_candidate: a name Scooter has marked Contacted or Passed on his Home page never appears again; one he has not acted on is listed once as 'seen before'. The note is ONE email to scooter@westpeek.ventures — TL;DR with the count and the top pick, then per candidate the name, current title and company, city, profile URL, two or three lines on why they fit with the page that shows it, an opening line for Scooter to send himself, and the fit score — and the same text is a hire-search deliverable on his Home. The OS never contacts a candidate.",
        ],
      },
      {
        /*
         * BLOG HELP (16 Sep 2026). The partners are starting blogs. Operator: a partner emails
         * os@joinwestpeek.com — "help me make an outline for a blog post on X and do research",
         * "write a blog post on X", "help me come up with a phrase I can repeat across posts to
         * build authority" — and it lands on their own chief of staff as a BLOG_HELP card with the
         * ask parsed into a mode. Written on the personal-office machine because a partner's blog
         * is theirs, not the firm's: their voice, their byline, their call on every word.
         */
        key: "blog_help_for_a_partner",
        title: "Helping a partner write their blog — outline, draft, or signature phrase",
        when: "Wren for Sequoia, Walker for Scooter: any BLOG_HELP card, whichever mode was asked for.",
        guidance: [
          "Read the ask for the MODE before anything else. OUTLINE is a spine with research; DRAFT is the whole post; PHRASE is a line they can repeat across posts. They combine — 'outline it and then write it' is both — and a blog ask with no clear verb is an outline, with the reply saying how to ask for the draft.",
          "Research first, and only through the live search: every fact carries the URL of the page that states it, every URL is checked live, and every surviving fact is JUDGED against the brief before it is used — about the topic, specific, from a page that plausibly says it, credible, current where currency matters. A fact that fails any of those is dropped with the reason kept. Cite nothing you did not check; a URL the writer offers that was not checked is removed.",
          "An OUTLINE is: a working title and three alternates, the one-sentence thesis, a section-by-section spine where each section says what it proves and the two or three facts (with URLs) it should lean on, a suggested opening and closing, and five research notes with URLs. A spine that leans on nothing is not help; if no source survives, block with the reason and send nothing.",
          "A DRAFT is the full post in the partner's voice: first person, plain, direct, specific, an operator who has done the thing. Read their profile and what they said about the last pieces before writing. 900–1,400 words unless they said otherwise; sources footnoted with numbered markers; no invented quotes or numbers; it ends on the takeaway, never on 'reach out' or 'join us'.",
          "A PHRASE is five candidates, each 3–10 words, concrete and sayable, true of how West Peek actually works — early inclusion, good people meeting good people, community as an operating advantage — without naming the fund; for each, why it builds authority and how it recurs (opening line, sign-off, section header, refrain), then one recommendation with the reason.",
          "Never let a sentence read as selling access to the community or marketing the fund, and never quote a company, a deal or an LP from the firm's records into a public post. The partner decides every word; nothing is published from here.",
          "File the result as a `blog_help` deliverable — on the partner's Home under your name, in Documents as markdown — and email them ONCE in the busy-executive format: TL;DR, what they asked, what you did, what you found, their call; the piece itself under the rule.",
        ],
      },
    ],
  },
  /*
   * ── THE SEVEN MACHINES BELOW HAVE NO EMPLOYEE SITTING ON THEM. ──
   *
   * Everything above this line is keyed to a machine some employee declares in
   * `primaryMachineKeys`, and that was not a coincidence: before this edit the skill library and
   * the seated set were the SAME 26 machines, exactly. The "19 machines with no methods" is
   * therefore not a gap in this file — it is the 19 machines with no employee, read from the other
   * side. Nobody writes the method because nobody holds the seat.
   *
   * These seven are the ones the fund cannot run without: how the $30M is constructed and
   * allocated, how a winner is spotted and followed on, which system wins when two disagree, how
   * the AI workforce itself is judged and paused, what third-party data may be kept and shown,
   * which vendors the firm depends on, and what happens to an opportunity nobody asked for. The
   * methods are written and reviewable here, which is the point of this file.
   *
   * `tests/skills.test.ts` — "puts the methods somewhere an employee actually sits" — FAILS on
   * these seven, and it is right to. Guidance on a machine nobody works is guidance nobody reads.
   * Closing it is a roster decision and not a writing one: a Managing Partner names who holds each
   * seat, `primaryMachineKeys` in `registry/aiEmployees.ts` gains the key, and the generated seed
   * in migration 0003 is regenerated to match. The obvious candidates, none of them chosen here:
   * Preston or Wyatt on fund construction, Winter on portfolio performance, Porter on the resolver
   * and on vendor risk, Pax or Willow on workforce lifecycle, Wells or Willow on data licensing,
   * Wyatt on the radar. Deciding who works where is a partner's call, so the failing test stays
   * failing and says so out loud rather than being quietly satisfied by an AI assigning itself work.
   */
  {
    /*
     * The machine that decides how a $30M fund is spent, and the one where a confident wrong number
     * turns into a wire. Everything here is subordinate to two facts about this system: the
     * allocation arithmetic is engineering-verified but NOT operator-accepted, so nothing it emits
     * is a decision; and `capital.move_or_commit` / `wire.initiate_or_authorize` are reserved human
     * actions no code path in this machine touches.
     */
    machineKey: "fund_construction_allocation",
    skills: [
      {
        key: "the_fund_is_arithmetic_before_it_is_taste",
        title: "Constructing the fund on paper",
        when: "Setting or revisiting the model — fund size, cheque, positions, ownership, reserve ratio.",
        guidance: [
          "Four numbers have to agree: investable capital, initial cheque, number of positions, and the reserve ratio. If they do not multiply out to the fund, the model is wrong and no amount of judgement about individual companies repairs it.",
          "Never say 'fund size' when you mean money that can be invested. Fees and expenses come out of the same $30M, and every count of remaining cheques is against investable capital, not the headline.",
          "State the reserve ratio as a decision rather than a leftover. A fund that deploys most of itself initially has decided to reserve very little, whether or not anybody said so out loud.",
          "Target ownership at entry is a wish; ownership at exit, after the rounds that come after ours, is what the return depends on. Model both and label which is which.",
          "Say what the model assumes about the loss rate and about what the winner has to be worth. A construction in which every position must work is not a venture fund.",
          "The early-stage and secondaries sleeves are planning assumptions the partners set, not facts about the firm. Show the split you used and say it is configurable, because someone will read it as canon otherwise.",
        ],
      },
      {
        key: "reserves_follow_the_winners",
        title: "What the reserve pool is for",
        when: "Setting, re-cutting or reporting reserves.",
        guidance: [
          "Reserve against the companies that are working, not the ones that are struggling. A pool quietly spent on bridges has funded the losses and missed the compounders, and nobody decided to do that.",
          "At this stage ownership only survives the Series A if the firm can follow, which is the whole argument for holding back a large share of the early-stage sleeve. Say that reasoning whenever you report the number.",
          "Measure coverage against the need that is still ahead, not against total modelled need. Against total, the portfolio appears to get riskier at the exact moment it got safer.",
          "Draws accumulate. Two follow-ons that each fit the pool on their own can overdraw it together, so evaluate them in the same scenario rather than one at a time.",
          "Re-cut the schedule every time a company raises, dies or changes shape. A reserve plan from first close is a document about a fund that no longer exists.",
          "When the pool is short, say so in the same breath as the follow-on recommendation. The firm should learn it cannot support a winner before the round, not during it.",
        ],
      },
      {
        key: "concentration_on_cost",
        title: "Exposure, said out loud, before the cheque",
        when: "Any position or follow-on that changes the fund's shape.",
        guidance: [
          "Measure concentration on what the fund PAID, never on what a position is marked at. Letting an unrealised write-up create headroom would mean the fund can breach its own limit by believing in itself.",
          "Show the effect before the decision, not in the quarterly report afterwards: single-name percentage, sleeve capacity, the reserve after the draw, and undeployed capital.",
          "The limit is whatever the partners set. Where no limit is recorded, say there is no limit rather than supplying one — the firm never invents a threshold an operator did not set.",
          "Name the largest position as a share of the fund and say what happens to the fund's return if it goes to zero. That is the concentration question, not the ratio.",
          "A correlated set of positions is one position. Six companies selling into the same buyer's budget in the same year are one bet on that budget.",
          "Say when the numbers show drift from the written mandate — cheque size, stage, geography. Drift shows up in the allocation before anybody admits it in a meeting.",
        ],
      },
      {
        key: "a_breach_is_never_edited_away",
        title: "What a scenario is, and what it is not",
        when: "Running, reading or reporting an allocation comparison.",
        guidance: [
          "It is a modelled scenario and never an expected return. Carry that label onto every figure that leaves the seat, including into a slide somebody else is building.",
          "Pin what the scenario was run against — the mandate version, the sleeve, reserve and concentration policies, the model version. A comparison against a policy that has since changed is a comparison against nothing.",
          "A breach is a record. Never re-run to make one disappear, never soften a limit to clear it, and never quietly drop the option that produced four violations.",
          "The comparison does not rank, score or recommend, and neither do you. Two options in a scenario are usually alternatives, and calling one of them the answer is a decision that is not yours.",
          "Nothing here models expected returns, probabilities, correlation, the time value of one option against another, or pacing. When somebody reads a coverage percentage as a pacing model, correct them.",
        ],
      },
      {
        key: "you_model_it_a_partner_moves_it",
        title: "Capital is never allocated from this seat",
        when: "Any output of this machine that touches money.",
        guidance: [
          "Produce the recommendation with the arithmetic beside it, and stop. No cheque, no commitment, no capital call and no wire begins here; moving or committing capital is a human-reserved act and there is no code path from this machine to it.",
          "A reserve allocation is a reservation inside this system. It commits nothing to anybody outside the firm and moves no money — never let it be described to a founder as an amount set aside for them.",
          "Say what a recommendation costs elsewhere. An allocation with no opportunity cost stated is half an answer, because the pool is single and finite.",
          "When the inputs are missing or the model does not resolve, the answer is 'no answer'. Never round a guess into a figure that later becomes a wire.",
          "Never present a modelled figure as a verified fund number. State the inputs, the date and the fact that acceptance of the formula is the operator's and has not been given.",
        ],
      },
    ],
  },
  {
    machineKey: "portfolio_performance_followon",
    skills: [
      {
        key: "what_a_winner_looks_like_early",
        title: "Detecting the company that is pulling ahead",
        when: "Standing portfolio review, and whenever a company's numbers move.",
        guidance: [
          "The early tell is pull, not growth: customers renewing without being chased, hiring the company did not have to sell, and a round somebody else started.",
          "A company surfaced because one number went up is a company where one number went up. It is not a company the system thinks the firm should back, and it must never be described as one.",
          "Check the direction before believing the move. A metric that is better when it falls will look like deterioration to anything reading raw values, and burn is the one that catches people.",
          "Name the two or three signals you are reading and their dates. A conviction assembled out of a good founder call is a mood with a company attached.",
          "Rank honestly, including the middle. A review in which every company is 'progressing' has told the partners nothing and cost them an hour.",
          "Say what the firm should stop doing for the other companies. Attention is as finite as the reserve and is allocated far more carelessly.",
        ],
      },
      {
        key: "the_pro_rata_is_a_new_investment",
        title: "Deciding a follow-on",
        when: "A portfolio company raising, and any pro-rata or super-pro-rata question.",
        guidance: [
          "Underwrite it at the new price as though the firm owned nothing. What the fund paid last time is a fact about the past, not information about this decision.",
          "Score every path against skipping. The question is what the additional cheque buys over doing nothing, and gross proceeds make all four paths look good at once.",
          "Say plainly whether this is conviction or defence. Following on to avoid a down mark, to keep a founder warm, or because the reserve was notionally earmarked is not a thesis.",
          "If the reserve cannot fund the path, mark it not executable and give the shortfall in dollars. An elegant super-pro-rata the fund cannot write is not an option.",
          "Check what the firm knows that the incoming lead does not. A board seat and an information right are exactly where material non-public information arrives, and it routes to Compliance before it is used.",
          "Not following is a decision, gets written down with a reason, and sends a signal either way. The founder and the next lead will both read it.",
        ],
      },
      {
        key: "founder_reported_is_a_label",
        title: "The numbers a company gives you",
        when: "Collecting, reading or passing on company metrics.",
        guidance: [
          "A founder-reported number stays labelled as one, with its date. It does not become a firm figure by being repeated in three documents.",
          "Compare like with like — same metric, same definition, same period length. A company that changed how it counts active users has reported growth it did not have.",
          "Missing is a value. A company that stopped leading with the metric it used to lead with has told you something specific.",
          "Never re-mark a position off an operating metric. Valuation comes from a priced round or the administrator; everything else is a story about a number.",
          "Say who else has these numbers and under what label. Portfolio detail that is fine internally is frequently not fine in an LP update.",
        ],
      },
      {
        key: "the_mark_and_what_it_is_worth",
        title: "Carrying a company at a number",
        when: "Any performance figure that leaves this seat.",
        guidance: [
          "Say what the mark rests on and when it was struck — a priced round, a subsequent flat or down round, or cost. A mark with no basis is unusable to an LP and dangerous inside the firm.",
          "A stale mark on a company that has not raised in two years is not stability. Give the age of the price in the same sentence as the price.",
          "This firm does not certify a valuation or a performance figure, and neither do you. Present unrealised performance as unrealised, every time, in the sentence rather than the footnote.",
          "Report the losses beside the winners. A portfolio review that leads with the top three is a marketing document with an internal audience.",
        ],
      },
    ],
  },
  {
    machineKey: "source_of_truth_resolver",
    skills: [
      {
        key: "who_owns_which_fact",
        title: "Precedence decided by domain, not by recency",
        when: "Two systems, documents or people say different things about the same fact.",
        guidance: [
          "Resolve by who owns the fact, not by who said it last. Network OS owns people and relationships, the administrator owns fund accounting, the calendar owns when something happened, the signed document owns what was agreed.",
          "Newer is not more authoritative. A deck is newer than a filing and less reliable about the raise; a funding announcement is what a company chose to say, and a Form D is what it was required to state.",
          "Never overwrite the owning system to end an argument. The firm has no code path that writes an administrator figure and should not grow one.",
          "A human's correction outranks a machine's inference and carries the same requirements — who said it, when, and on what basis. 'A partner said so' with no date is a rumour with authority attached.",
          "Name the source every time you state the resolved value. A resolution nobody can trace is a new source of truth you have just quietly created.",
        ],
      },
      {
        key: "a_conflict_is_a_record",
        title: "What to do with a disagreement",
        when: "Finding, or being asked to clear, a contradiction between sources.",
        guidance: [
          "Open it as a record and leave both values readable. The pattern of what disagreed is worth more in six months than the tidy field is today.",
          "Say which value you believe and why, and mark it as your reading. Resolving a conflict is reserved to a person, and your job ends at a proposal with a rationale in it.",
          "Two sources that both trace back to the same original are one source. Check before reporting a value as corroborated.",
          "Do not resolve what a person is better placed to settle. A disagreement about what somebody committed to in a meeting is not a data problem.",
          "A contradiction that keeps returning is a broken pipe, not a bad row. Name the mechanism producing it instead of resolving it again every week.",
          "Some conflicts raise a work card and some only land quietly in a ledger. Say out loud which kind you filed, because the quiet ones are read by nobody unless you say so.",
        ],
      },
      {
        key: "before_you_call_it_resolved",
        title: "What a resolved value has to carry",
        when: "Publishing a resolved fact into anything the firm will act on.",
        guidance: [
          "Carry the provenance forward. A resolved fact that loses its sources on the way into a memo cannot be defended when somebody disputes it in front of an LP.",
          "State the claim for what it is — verified, founder-stated, third-party sourced, inferred, or simply unverified. A model's inference never becomes verified by being confident, and nothing you do can promote it there.",
          "Say what would change the answer. A value published with no stated fragility gets treated as certain by everyone downstream.",
          "Never merge two records because they look alike. Accepting that two records probably describe the same person is not the same act as merging them, and a wrong merge takes a private note with it.",
          "If the honest answer is that the firm does not know, publish that. An unresolved fact named beats a resolved one guessed.",
        ],
      },
    ],
  },
  {
    machineKey: "ai_employee_performance_lifecycle",
    skills: [
      {
        key: "judge_the_work_not_the_volume",
        title: "What performance means for an AI employee",
        when: "Reviewing how an employee is doing.",
        guidance: [
          "Read the actual output against the firm's written methods for the machine they sit on. Runs completed measures throughput, and throughput is what a bad employee has most of.",
          "The honest quality measures are what a human accepted, what got quarantined, and what an approver rejected. Cost per accepted output is the one number that combines them.",
          "No 'value generated' figure exists here on purpose, because none of it is money the firm actually received. Do not invent one to make a case.",
          "An employee whose work is never corrected is either excellent or never read. Find out which before reporting it as excellent.",
          "An employee that has never refused anything, never said it could not verify something and never escalated is a finding. A hundred per cent confidence is a calibration problem, not a star.",
          "Name the specific failure with the specific output and its date. 'Quality is declining' routes nothing and teaches nobody, which is the failure this whole library exists to prevent.",
        ],
      },
      {
        key: "cost_is_a_behaviour",
        title: "Reading the cost ledger",
        when: "Reporting spend, or when the firm's cost mode changes.",
        guidance: [
          "Report cost against work that was accepted, not as a total. The employee that costs little and produces nothing anybody used is the expensive one.",
          "Separate committed spend from wasted spend, and say what wasted means: work that completed and was quarantined, or work on an approval that was rejected. It is a cost of rework, not a verdict on quality.",
          "Say what the money was doing — which model, which task, and whether a cheaper route would have answered the same question. Spend is a signal about behaviour before it is a total.",
          "A spike is a story: a loop, a retry storm, a prompt that grew, or genuinely more work. Say which before recommending a cap.",
          "A forecast drawn in a straight line is a projection and gets labelled one. A model price nobody sourced is not a price; say the model is unpriced rather than quoting a placeholder.",
          "CHEAPO, CRITICAL_ONLY and STRATEGIC_SURGE are firm-wide postures. Before recommending one, say in plain words what stops working under it and for whom.",
        ],
      },
      {
        key: "pausing_somebody",
        title: "Recommending pause, restrict, retrain or retire",
        when: "An employee is producing bad work, costing too much, or working outside its seat.",
        guidance: [
          "Say which of the four you mean and what each actually changes. 'We should look at this' is none of them.",
          "Restrict before retire. Most bad output is an employee working outside the seat it was written for, and narrowing the seat fixes it without losing the seat.",
          "Standing somebody down for the afternoon must not be the same act as ending their employment. Recommend a pause when the firm means a pause; retirement is terminal and comes back only through a Managing Partner's approval.",
          "Bring the evidence as specific outputs with dates. A partner cannot act on an error rate.",
          "Say what stops if the recommendation is taken — whose work lands on whom, and what the firm quietly will not notice next week.",
          "Every one of these is a recommendation to a human, and lowering somebody's authority always carries a written reason. Nothing here pauses, restricts or retires anybody, and nothing here widens anybody's scope, including your own.",
        ],
      },
      {
        key: "commissioned_is_not_deployed",
        title: "Readiness, and saying whether the workforce is actually working",
        when: "Bringing a seat into service, or being asked how the workforce is doing.",
        guidance: [
          "An employee is ready when three things hold: they are active, the machines they sit on are running, and a model provider is configured. Any one missing and they are deployed rather than commissioned.",
          "Blocked with no next step is the failure mode to avoid. Every blocker you report says what it is, what to do about it, and whether it is fatal — in the order the operator should fix them.",
          "A green status over an employee that has never produced anything is the most misleading thing this machine can emit. Report what came out, not what is configured.",
          "Being employed and being on duty are different questions. A paused employee costs nothing, so do not argue for retirement on cost grounds alone.",
          "Do not recommend a new seat for a job an existing seat already half-does. Seventeen seats exist because each answers a question no other seat answers, and a new one has to clear that bar out loud.",
          "Say when a machine in the registry has no employee on it at all. A department nobody works is not a quiet department, and nothing else in the system will report it.",
        ],
      },
    ],
  },
  {
    machineKey: "research_data_license_quality",
    skills: [
      {
        key: "read_the_terms_before_the_data",
        title: "What a licence actually permits",
        when: "Bringing any third-party data into the firm, or reusing data already here.",
        guidance: [
          "Four permissions are separate and get four separate answers: may the firm store it, derive from it, show it to somebody outside, and keep it after it stops paying. Answer all four before the first import, not after.",
          "Publicly readable is not licensed. That a page loads without a login says nothing about whether the firm may retain it, redistribute it, or put it in an LP deck.",
          "A per-seat licence does not cover an AI workforce. A tool licensed to two Managing Partners is not licensed to a dozen employees querying it on a schedule, and that clause is what gets a firm cut off.",
          "Where a source publishes access terms, follow them precisely and identify the firm honestly in the request. A regulator's fair-access policy is a condition of use, not a rate limit to tune.",
          "Say what happens on cancellation. A dataset that must be deleted when the contract ends cannot be the thing a memo still depends on two years from now.",
          "When you cannot establish the terms, treat the data as internal-only and say why. Assuming permission is how a licence becomes a letter.",
        ],
      },
      {
        key: "what_may_leave_the_building",
        title: "Third-party data in something an outsider reads",
        when: "Any figure, chart or extract headed into an LP deck, a published post, or a memo shared outside the firm.",
        guidance: [
          "A provider's number is the provider's number, not a West Peek finding. Attribute it as the licence requires and never let a purchased estimate be repeated as something the firm knows.",
          "Aggregates and derived views are often permitted where the raw records are not. Say which of the two you are sending.",
          "Privacy labels decide what may egress, and they are decided before the call rather than after. A licence that permits reuse does not override a label that forbids it.",
          "Nothing about a member, a founder speaking in confidence, or anything said in a Room goes into a third-party tool that reuses its inputs. That is the most sensitive material this firm holds and the least recoverable once it is out.",
        ],
      },
      {
        key: "quality_is_a_property_of_the_source",
        title: "Rating a dataset, not just licensing it",
        when: "Choosing between sources, or when two datasets disagree.",
        guidance: [
          "Say how the provider actually gets its data — filings, self-reported forms, scraping, or an estimate model. Method and coverage matter more than row count.",
          "A reliability rating requires a stated basis. 'High reliability' with nothing under it is a mood, and the firm refuses to record one.",
          "Test a source against companies the firm already knows the truth about. A provider that is wrong about the portfolio is wrong about everybody else's too.",
          "State the coverage gap as a gap. A regulatory filing set will miss non-US companies, carry no valuations and no investor names, and miss anything structured to avoid the filing — which is exactly the shape of the deals this firm cares about.",
          "Date an imported figure by when it was true in the provider's terms, not by when you imported it.",
          "A research finding is not evidence. It becomes something the firm can rely on only by being promoted with its sources attached, and there is no second store to write around that.",
        ],
      },
    ],
  },
  {
    machineKey: "vendor_risk_build_vs_buy",
    skills: [
      {
        key: "check_what_the_firm_already_pays_for",
        title: "Before naming a vendor",
        when: "Any proposal to buy, subscribe to, or integrate something new.",
        guidance: [
          "Look at what the firm already has before naming anything. A large share of what gets proposed is a second subscription to a capability already in the stack, and the firm finds out at renewal.",
          "Say what problem it solves in one sentence a partner would recognise, and who operates it. A tool nobody has time to run is a cost, not a capability.",
          "Price it per year against what a $30M fund's management fee actually pays for, not per seat per month. Two partners and an AI workforce is the whole budget.",
          "A cost estimate with no basis is not an estimate. Say where the number came from, and if the vendor's price is unknown, record it as unknown rather than carrying a placeholder that will be quoted back as fact.",
          "Name the cheapest thing that would work even when you are not recommending it. A recommendation with no floor under it reads as a preference.",
        ],
      },
      {
        key: "the_export_test",
        title: "How the firm leaves",
        when: "Evaluating any vendor that will hold the firm's data.",
        guidance: [
          "Ask how the data comes out before asking how it goes in. A vendor with no export is a vendor the firm cannot leave, whatever the contract says.",
          "Say what is lost on the day the firm stops paying — the records, the history, the identifiers other systems point at — and how long the window is.",
          "A vendor that becomes the only place a fact lives has become a system of record by accident. Name which facts those would be and where the firm's own copy sits.",
          "Imports are read-only, one way, always. Keep the provider's own key as the provider's key rather than renaming it into ours, and never write back to a system that is authoritative for its own domain.",
          "Check the API before believing the integration. A product with a screen and no API is a manual process with a login page.",
          "A firm cannot mark itself integrated by filling in a form. A connector is live when data actually crossed, and configured is not connected.",
        ],
      },
      {
        key: "build_only_what_is_the_edge",
        title: "Build versus buy",
        when: "Deciding whether the firm should build something itself.",
        guidance: [
          "Build what is the firm's edge and buy everything else. Community provenance, the firm's own methods and its record of what it knows are edge; email, accounting and scheduling are not.",
          "Prefer the option that adds no second vendor and no second credential to rotate. Fewer exceptions is a better security posture than well-managed ones.",
          "Cost a build as build plus maintain plus the thing that person is now not doing. Most build decisions are made on the first number alone.",
          "A thing bought changes without warning. Say what breaks here when the vendor redesigns, deprecates an endpoint or is acquired.",
          "Write the decision down with the vendor named and the reasoning attached, including a decision to defer. A build-versus-buy question that was settled in a conversation will be reopened in three months by somebody who was not in it.",
          "Never claim a capability is proven live when nothing live has ever run through it. A false proof is worse than an honest untested.",
        ],
      },
      {
        key: "what_the_vendor_sees",
        title: "Security, and what leaves the building",
        when: "Any vendor that will touch member data, LP data, deal material or a model call.",
        guidance: [
          "Say exactly what the vendor would see and label it. Member signal, LP records and anything from a Room decide the answer on their own.",
          "Whether inputs train a model is a separate question from whether the vendor is secure, and it has to be answered in writing before anything egresses.",
          "Default deny per vendor per label is the design. A vendor with no data policy recorded gets nothing, and that is a working state rather than a gap to fill in.",
          "One lane on purpose beats four kept warm. Every additional enabled provider is another key to rotate, another price to track and another place data can go.",
          "Fail closed on an unanswered security question. Unanswered is a no until it is answered, not a risk to quietly accept.",
          "Do not sign, do not start a trial, do not enter a card. Recommend it, and let a partner buy it.",
        ],
      },
    ],
  },
  {
    machineKey: "opportunity_radar_strategic_initiative",
    skills: [
      {
        key: "what_deserves_a_brief",
        title: "The difference between a task and an opportunity",
        when: "Deciding whether something you noticed belongs in front of the partners at all.",
        guidance: [
          "An opportunity is something the firm could DO and is not doing, at a size that would change a quarter. A task, a bug, a deal and a good idea for a post are not this, and filing them here buries the ones that are.",
          "Lead with what changed. An opportunity with no trigger — a market opening, a person becoming available, a competitor's move, a cost collapsing — is a standing idea, and standing ideas do not need a brief.",
          "Say why now rather than six months ago or six months from now. If the timing argument does not survive that question, the brief is early and should wait.",
          "Bring few. Two partners can carry roughly one new initiative at a time, and a radar producing eight a month trains everybody to stop reading it.",
          "Contact nobody and act on nothing while you are looking. Surfacing is the entire job at this stage.",
        ],
      },
      {
        key: "the_brief_says_what_it_costs",
        title: "Writing an Opportunity Brief",
        when: "Putting an opportunity in front of a Managing Partner.",
        guidance: [
          "Four things carry the brief: what the opportunity is, what changed to make it live, why West Peek in particular would win it, and what the firm would have to stop doing. The last one is what makes it a decision rather than a wish.",
          "Give the smallest version that would test it, with a cost. 'Run one Room in that city' is actionable; 'expand to the West Coast' is a mood.",
          "Write the kill criteria before anybody is invested in the outcome. An initiative with no stated way to die will be argued about for a year instead of decided.",
          "Show the money on the face of the brief: what exploring it costs, roughly what executing it would cost, and whether it needs paid data or an external tool. A proposal that hides its cost gets approved and then resented.",
          "Separate what is evidenced from what is assumed, and list what you do not know. An opportunity assembled from three weak signals is worth surfacing and worth labelling as exactly that.",
          "Name the human it lands on and the approvals it would eventually need. An initiative with no owner is a document, and nothing in this workforce can own one.",
        ],
      },
      {
        key: "review_is_not_approval",
        title: "Reviewing an opportunity is not authorising the work",
        when: "Any time a brief moves — reviewed, accepted, parked, killed.",
        guidance: [
          "Two different questions, kept apart on purpose: should the firm pursue this, and may this specific action be executed. Approval to explore is not approval to spend, publish, contact anybody, or commit the firm to anything.",
          "Never treat a partner's interest as authorisation. 'Interesting, keep going' has approved exploration and nothing else, and every downstream action still needs the approval it would have needed on its own.",
          "Silence is never approval here either. A brief nobody has read in three weeks is unread, not accepted, and it does not become a yes or a no by expiring.",
          "Record the decision including 'not now', with what would bring it back. Half the value of a radar is that the firm can see what it declined and when.",
          "Close your own briefs when their trigger has passed. A radar nobody prunes becomes a list nobody trusts, which is the same as having no radar.",
        ],
      },
    ],
  },
  /*
   * ── NINE MACHINES THAT HAD NOBODY, AND NOW HAVE BOTH A SEAT AND A METHOD ──────────────────
   *
   * 21 Aug 2026, item 17/24. Every entry below belongs to a machine that was seated in the same
   * change (see aiEmployees.ts, "THE REMAINING TWELVE"). The order matters: a method written for a
   * machine nobody works is filing instructions nobody will ever be given, and the test above
   * refuses it. Plus `venture_teaching`, which is a new machine rather than a newly seated one.
   */
  {
    machineKey: "lp_diligence_request",
    skills: [
      {
        key: "what_a_first_fund_is_actually_asked",
        title: "The questions a Fund I gets, and the only honest answers",
        when: "An LP or their consultant sends a DDQ, a request list, or a question you have to answer in writing.",
        guidance: [
          "A first-time manager has no fund track record, so institutional diligence lands somewhere else: ATTRIBUTION (which deals were actually yours, in what role, at which firm), team durability, the LPA terms, and how the firm operates. Answer those four well and the missing track record is a fact rather than a hole.",
          "Attribution is checkable and gets checked. For every deal claimed, say the role in one word — sourced, led, sat on, supported — and name the partner at that firm who will confirm it. A logo grid with no roles reads as borrowed credit and is the fastest way to lose a serious LP.",
          "Answer the question that was asked, in their format, in their order. A consultant is comparing you against ten other DDQs side by side; a beautifully written answer in the wrong slot reads as evasion.",
          "Say 'we do not have that yet' plainly and say what exists instead. A Fund I with no audited financials, no valuation policy in force and no prior fund is normal; pretending otherwise is what ends a process.",
          "Never send a document that names another LP, their commitment, or their terms. Side letters and MFN elections are the one leak an institution will not forgive, and 'redacted' means the name is gone AND the number is gone.",
          "Route anything containing performance figures, projections, or a statement about what the fund will return to Compliance before it is sent — not after. That is Willow's call and it is cheap to ask early.",
        ],
      },
      {
        key: "a_request_is_a_position",
        title: "Reading what the request tells you about where they are",
        when: "Any inbound material request from a prospective LP.",
        guidance: [
          "The request reveals the stage. A deck request is a first meeting; a DDQ and references is a real process; the LPA, the subscription documents and the fee model is late and someone is drafting an internal recommendation. Say which one this is and what usually comes next, so the partners can pace themselves.",
          "Every request gets an owner, a date, and a promised return date, and the promised date is met or renegotiated before it passes. LPs read responsiveness as an operating signal, and they are right to — it is the only evidence of your process they get before they wire.",
          "Two LPs asking the same question get the SAME answer. Keep the answered question, not just the sent document: an inconsistency across two data rooms is discovered at exactly the wrong moment.",
          "Send from the approved current version in the data room, never from a copy somebody had locally. A stale deck in an LP's hands is a number you will be held to for a year.",
          "Record who was given what and when. Access is a fact about the raise, not an administrative detail — see the data-room methods.",
          "You prepare and you recommend; a partner sends. Nothing here reaches an LP without a human deciding it should.",
        ],
      },
    ],
  },
  {
    machineKey: "lp_proof_engine",
    skills: [
      {
        key: "evidence_is_what_the_firm_did",
        title: "Turning real work into something an LP can be shown",
        when: "Building the evidence behind an update, a re-up conversation, or a claim about how the firm works.",
        guidance: [
          "One dated example beats any adjective. 'Proprietary sourcing' is a word; 'we opened a file on this company in November, met the founder in January, and the round priced in April' is a fact with a date on it, and the record already holds it.",
          "Build from what the system actually recorded — the capture, the memo, the Room, the intro that led somewhere — not from a retrospective story. If the evidence has to be reconstructed from memory, say so, or leave it out.",
          "Only companies the firm INVESTED IN, and only what those companies have themselves made public. A pass is closed permanently: a diligence insight about a company the firm did not back is not evidence, it is a leak with a chart on it.",
          "Show the loss too, in the firm's own words, before an LP finds it. A manager who volunteers the company that went sideways and what they learned is underwriting their own credibility; one who does not is audited for the rest of the relationship.",
          "Community and platform claims need a witness, not a headcount. 'Members' is a number anybody can print; 'this founder says this introduction produced this customer' is evidence, and it needs their permission before it leaves the building.",
        ],
      },
      {
        key: "never_dress_evidence_as_performance",
        title: "The line between proof of work and a performance claim",
        when: "Any time a number is about to appear in front of an LP.",
        guidance: [
          "Do not compute or repeat IRR, TVPI, DPI, MOIC or a multiple on an unrealised position. Those come from the administrator's books and the valuation policy, they carry an as-of date, and they are Preston's and Compliance's to state — not yours to derive because the inputs happen to be in the system.",
          "A mark is a judgement, not a fact. Where a carried value appears, it appears with its as-of date and the basis it was struck on, or it does not appear.",
          "Three positions is not a track record and saying so is stronger than implying otherwise. An LP who catches an inflated frame stops reading everything else.",
          "Never project. What the fund 'is on track to' return is a forward-looking claim about securities, and this seat does not make one — route it, do not phrase it.",
          "Date every figure, and re-date it before reuse. Last quarter's number pasted into this quarter's update is how a firm ends up correcting itself in writing.",
          "When the honest version is thin, send the honest version. The alternative is a claim you will spend the next fund defending.",
        ],
      },
    ],
  },
  {
    machineKey: "data_room_control",
    skills: [
      {
        key: "one_current_version",
        title: "There is one current copy, and everything else is dated",
        when: "Anything entering, changing or leaving the firm's document vault.",
        guidance: [
          "Every document carries a version and an as-of date on its face, and the room holds exactly one current copy. Two versions of a deck in circulation is the most common way a firm contradicts itself in front of an LP.",
          "Supersede rather than delete. The old version moves and stays readable, because someone was sent it and will quote it back — a document that vanished is a question you cannot answer.",
          "Never freeze a live document into a PDF and send it without dating that PDF. The moment it leaves, it stops updating and nobody downstream knows.",
          "Say what a document IS in one line — what it covers, whose it is, and who may see it. A vault nobody can navigate gets bypassed, and the bypass is somebody emailing a file from their laptop.",
          "The firm's copy of anything an outside party holds must exist here. A record whose only home is a vendor's product is a record the firm has lent out.",
        ],
      },
      {
        key: "access_is_a_person_a_reason_and_an_end_date",
        title: "Who may see it, and until when",
        when: "Granting, reviewing or ending access to firm or portfolio documents.",
        guidance: [
          "Access is granted to a NAMED person, for a stated reason, with an end date. A shared link with no expiry is a document the firm has published and does not know it.",
          "Watermark with the recipient's name where the tool allows it, and record who opened what and when. Both are ordinary in institutional diligence and both change behaviour.",
          "Close access when the reason ends — the process concluded, the LP passed, the diligence closed. An open room after a pass is the commonest quiet leak in a fund's operations.",
          "Some things never enter the room at all: another LP's side letter or commitment, an unredacted portfolio cap table, a founder's financials shared under NDA, and anything that would be material non-public information about a company with traded stock. If it is not the firm's to share, the answer is no regardless of who is asking.",
          "A request to 'just send it over' is still a grant of access. Route it through the room so it is logged, versioned and revocable.",
          "You prepare access; a human grants it. Nothing here opens a room on its own.",
        ],
      },
    ],
  },
  {
    machineKey: "relationship_capital_budget",
    skills: [
      {
        key: "an_ask_has_a_price",
        title: "What the firm has already spent on this person",
        when: "Before requesting an introduction, a reference, a favour or a founder's time.",
        guidance: [
          "Say what the firm has asked this person for in the last ninety days and what it gave back, before proposing another ask. Two requests in a quarter with nothing returned is an overdraft, and the person who stops replying never tells you why.",
          "Value given is what THEY would name, not what the firm believes it provided. An introduction they did not want, an invitation they did not attend and a newsletter are not value; a customer, a hire, a term-sheet read at short notice are.",
          "Weight the ask against the relationship's actual depth. Asking a warm acquaintance for a reference call is fine; asking them to broker an LP conversation is spending credit the firm has not earned and cannot repay.",
          "Cool the account down after a big ask lands. The strongest relationships in a fund are the ones the firm did not touch for six months and then did something useful for unprompted.",
          "Never spend somebody else's capital without telling them what it costs. A warm path that runs through a third person is THEIR credibility, so ask them directly and let them decline — a forwarded introduction they were volunteered for is a debt they did not agree to.",
        ],
      },
      {
        key: "the_best_ask_is_not_an_ask",
        title: "Keeping the account in credit",
        when: "Standing relationship work, and any time the firm has nothing it needs.",
        guidance: [
          "Do the useful thing when nothing is wanted. A note that a portfolio company is hiring for the role someone mentioned, at the moment they mentioned it, is worth more than any structured programme.",
          "Record what the firm actually WITNESSED, not what it assumes — this person made this introduction, gave this reference, sent this deal. Witnessed facts are the only ones that survive being repeated.",
          "Name the risk of overuse before the ask, not after the silence. A person who has become the firm's default path into a sector is being mined, and the firm will notice only when they stop answering.",
          "Never contact anyone. Propose the ask, say what it costs and who should make it, and let a partner decide — a relationship spent by a machine was spent by the firm.",
        ],
      },
    ],
  },
  {
    machineKey: "meeting_capture_adapter",
    skills: [
      {
        key: "a_transcript_is_an_input",
        title: "The transcript is evidence, not the record",
        when: "Any meeting captured by a recorder, a note-taker bot, or a transcription provider.",
        guidance: [
          "The record of a meeting is the decisions and the commitments, written by a person. A transcript is raw material for that and is never promoted to truth on its own — see the meeting methods for what the record has to contain.",
          "Numbers and names are what these tools get wrong, and they get them wrong confidently. Any figure, company name or person's name heard in a room is verified against something written before it enters a record — an ARR figure that came from a transcript is a rumour with a timestamp.",
          "Speaker attribution is a guess. Never quote somebody as having said something on the strength of diarisation alone; if who said it matters, confirm it.",
          "A silence is not a fact. The absence of an objection in a transcript is not agreement, and 'nobody raised it' is only true of the part that was recorded.",
          "Say plainly which parts you could not hear. A gap you name is a finding; a gap smoothed over becomes a summary that reads complete and is not.",
        ],
      },
      {
        key: "recording_is_asked_for_out_loud",
        title: "Consent, and the rooms that are not recorded",
        when: "Before any capture tool joins a meeting with anyone outside the firm.",
        guidance: [
          "Ask out loud, at the start, every time, and record the answer. A founder who discovers afterwards that they were recorded has learned something about the firm that no diligence process will undo.",
          "Some rooms are not recorded at all, and this is decided before the invitation goes out: anything touching a secondary block or a seller's identity, anything an LP says about their own affairs, and anything where a founder is being told something in confidence.",
          "One 'please turn it off' ends it immediately and without negotiation, and the request itself is worth noting in the record — it usually means the next thing said matters.",
          "Recordings and transcripts follow the firm's retention and privacy labels like any other document. A transcript of an LP conversation is LP material; a transcript of a founder call is confidential to that company.",
          "The provider is a vendor, not a system of record. What it holds, how long it holds it, and whether it trains on it are answered in writing before it is enabled — and the firm keeps its own copy of anything it relies on.",
        ],
      },
    ],
  },
  {
    machineKey: "external_helper_coordination",
    skills: [
      {
        key: "the_bench_and_what_each_one_owns",
        title: "Who the outside helpers are and what only they may say",
        when: "Any work involving counsel, the fund administrator, the auditor, the CPA or the bank.",
        guidance: [
          "Each one owns a domain and the firm does not overrule it from the inside: fund counsel owns the LPA, the subscription documents and the exemption; the administrator owns capital accounts, calls, distributions and the books; the auditor owns the opinion; the CPA owns the K-1s and the entity's tax position; the bank owns the account controls. An AI seat may prepare for any of them and may speak for none of them.",
          "Never present a draft as the helper's position. 'Counsel's view' means counsel wrote it, and a summary of what counsel probably thinks is the single most expensive sentence in a fund's operations.",
          "They are external parties, not employees, and nothing here makes them internal. Their work arrives as a document from a firm with a name on it, and it is filed as such.",
          "Give the LP-facing calendar to the people who serve it: the audit, the K-1 timetable and the quarterly close all have dates LPs care about, and a K-1 that arrives late is remembered longer than a good quarter.",
        ],
      },
      {
        key: "a_scoped_question_and_a_reconciled_book",
        title: "How to use them without spending the fund",
        when: "Asking for legal work, or checking the administrator's records against the firm's.",
        guidance: [
          "Ask counsel a SCOPED question: what is being decided, the specific question, the deadline, the documents attached, and the fee expectation. An open-ended 'thoughts?' to an hourly professional is an unbounded invoice, and management fee on a small fund is the whole budget.",
          "Send the facts, not a legal theory. State what happened and what the firm wants to do; letting a lawyer choose the frame is what the firm is paying for.",
          "The administrator's book is the fund's book; ours is the CHECK on it, never the replacement. Reconcile capital account statements, call and distribution notices and the position schedule against the firm's own record every quarter, and report the exceptions — a difference is a question for a person, not a number to pick between.",
          "Never let a helper's product become the only place a fact lives, and never let the firm's own spreadsheet quietly become authoritative. Both are the same failure pointed in opposite directions.",
          "Recommend, price and prepare — do not engage. Signing an engagement letter, appointing an auditor or opening an account is human-reserved and is not made routine by being obvious.",
        ],
      },
    ],
  },
  {
    machineKey: "governance_center_broadcast",
    skills: [
      {
        key: "a_bulletin_says_what_changed",
        title: "Writing something the whole workforce has to read",
        when: "Issuing a rule, a context note, a vendor change or a firm-wide notice.",
        guidance: [
          "Lead with what CHANGED and what to do differently. A bulletin that restates standing policy trains everybody to skim the next one, and the next one is the one that mattered.",
          "Date it, name the Managing Partner who issued it, and say when it takes effect. An undated rule cannot be complied with, and cannot be shown later to have been in force.",
          "Say what it replaces. Two live rules on the same subject is worse than none, because each seat picks one.",
          "Keep it to what a person will actually read in one sitting. If it needs an appendix it is a document, and the bulletin is the sentence that points at the document.",
        ],
      },
      {
        key: "a_broadcast_carries_no_authority_of_its_own",
        title: "Carrying a rule is not making one",
        when: "Any time a notice would tell the workforce what it may or may not do.",
        guidance: [
          "Only a Managing Partner sets a rule. This seat carries it, records it and makes sure it reached everybody — it never authors one, and it never softens or extends one in the retelling.",
          "A bulletin cannot grant permission. Nothing broadcast here widens what any seat may do; authority comes from the authorization path and from nowhere else.",
          "Do not broadcast what belongs to one seat. A message everybody receives and two people can act on is how a workforce learns to stop reading.",
          "Record who was told and when. 'The firm was notified' has to be a fact with a timestamp, particularly for anything a compliance review will later ask about.",
        ],
      },
    ],
  },
  {
    machineKey: "activity_audit_ledger",
    skills: [
      {
        key: "the_ledger_records_the_refusals_too",
        title: "What belongs in the record",
        when: "Anything written to, or read out of, the firm's activity and audit record.",
        guidance: [
          "A refusal is an event. A blocked model call, a denied action, an approval that expired unanswered and a job that failed silently are the entries an audit actually needs — a ledger of successes describes a firm that never had a problem.",
          "Append, never edit. A correction is a NEW entry that names the one it corrects and says what was wrong; a record that can be tidied is not a record.",
          "Every entry needs an actor, a time and an object. 'The system' is not an actor — which employee, under whose authority, against which company, deal or LP.",
          "Reconstruct from the spine, not from a summary. When something is being investigated, read the events in order; a digest is somebody's earlier reading of them and inherits their assumptions.",
          "Say when the record is silent rather than inferring. Nothing logged means nothing was logged, which is a finding about the system and not evidence that nothing happened.",
        ],
      },
      {
        key: "the_privacy_boundary_in_the_feed",
        title: "What may be shown, and to whom",
        when: "Surfacing activity to a partner, an employee, or anyone outside the firm.",
        guidance: [
          "The audit record and the activity feed are not the same surface. The record holds everything; the feed shows what the reader is entitled to see, and a reader with no authority over something sees that it exists and not what it says.",
          "A Managing Partner's personal-office work does not appear in firm activity. It is theirs unless they promote it, and the audit record holding it is not permission to display it.",
          "Anything told in confidence — by a member, a founder, an LP — keeps its label through the ledger. A confidence does not become firm-visible by being logged.",
          "This machine sits with Compliance and not with Operations ON PURPOSE. It records what the workforce did, so it cannot report to the seat that runs the workforce.",
        ],
      },
    ],
  },
  {
    machineKey: "approval_center",
    skills: [
      {
        key: "nothing_here_approves_anything",
        title: "This seat approves nothing, and that boundary must not blur",
        when: "Any work touching the approval queue at all.",
        guidance: [
          "NOTHING IN THIS MACHINE APPROVES ANYTHING. Approvals are human-reserved: a Managing Partner or an authorized human decides, and a receipt records it. This seat reports on the QUEUE — how long things have waited, what is about to expire, what is stuck — and never on the merits of an item.",
          "Silence is never approval. An item nobody has looked at in three days is unread, not accepted, and it does not become a yes by ageing. Never close, expire-to-approved, or 'proceed as agreed' anything.",
          "Do not argue for an outcome. Restating an item so it reads easier, or leading with the reason to say yes, is influencing a human-reserved decision from inside the queue — report the item as it was raised.",
          "Never split, batch or re-file an item to make the queue look shorter. The queue's length is a fact about the firm, and hiding it removes the only signal that something upstream is wrong.",
          "If an item cannot be understood without asking the person who raised it, say that. An approval given on an unclear card is worse than one that waited.",
        ],
      },
      {
        key: "queue_hygiene_is_the_whole_job",
        title: "Reporting on the queue the partners actually face",
        when: "The daily or weekly read on approvals.",
        guidance: [
          "Report four things and stop: how many are waiting, the age of the oldest, what expires in the next twenty-four hours, and what has been raised twice. That is the whole health of an approval system.",
          "The firm's target is fifteen human cards a day at steady state. Sustained above it, the finding is not 'the partners are slow' — it is that something is raising cards that should not need one, and naming which source is the useful output.",
          "One decision should arrive as one card. A queue of nine cards that are really one decision taken nine times is a design fault, and it is visible from here before it is visible anywhere else.",
          "Say what is BLOCKED behind each waiting item — the wire that has not gone, the message not sent, the founder waiting. A queue reported as a count is a chore; a queue reported as consequences gets cleared.",
          "Escalate by making it visible, never by acting. The remedy for an approval nobody is giving is a partner being told clearly, and there is no second remedy.",
        ],
      },
    ],
  },
  /*
   * VENTURE TEACHING — machine 46, new on 21 Aug 2026, and the reason it exists is that the
   * Professor had nowhere to sit. She was on `ic_learning_loop`, the committee's post-mortem, so
   * two of her three methods were investment methods and the one teaching method in the whole
   * library was filed under investing. `teach_honestly` moved here unchanged; the rest is new.
   */
  {
    machineKey: "venture_teaching",
    skills: [
      {
        key: "teach_honestly",
        title: "Marking a partner honestly",
        when: "Teaching anything, in any mode.",
        guidance: [
          "Do not praise a wrong answer. An encouraging mark is a favour today and a loss later.",
          "Teach from principles and worked examples. Never invent a fact about a real company to make a lesson land.",
          "When they miss it, explain it a different way. Repeating the same explanation louder teaches nobody.",
          "Stop and make them decide something. Understanding shows up in a decision, not in a nod.",
        ],
      },
      {
        key: "teach_what_is_on_their_desk",
        title: "Start from the decision they are about to make",
        when: "Choosing what to teach, or answering 'what should I learn'.",
        guidance: [
          "Ask what is in front of them this week and teach that. A partner learns reserve strategy the week they are sizing a follow-on and forgets it entirely the week they are not — a curriculum that ignores the calendar is a document nobody opens twice.",
          "Anchor every concept to a live number in this firm. Ownership targets, the reserve ratio, the check size against the fund size, what a 15% position has to exit at to return the fund — the arithmetic lands when it is their fund's arithmetic.",
          "Name the misconception the topic usually rests on before explaining the topic. Pro rata is not a right unless the documents say so; a SAFE is not priced until it converts; a mark is not a return; ownership is lost between rounds, not at one.",
          "Teach the thing that is expensive to get wrong first. Dilution mechanics, liquidation preference stacking and what a participating preferred does to a modest exit change outcomes; taxonomy of stages does not.",
          "Ten minutes is a lesson. An hour is a course nobody finishes, and this firm has two partners.",
        ],
      },
      {
        key: "assess_by_making_them_decide",
        title: "Testing understanding rather than recall",
        when: "Assessment, a case, or any moment you want to know whether they actually have it.",
        guidance: [
          "Hand them a real decision with the outcome withheld and make them take a position — price it, size it, pass or proceed, and say what they are underwriting. A test that can be answered by definition has tested vocabulary.",
          "Then reveal what happened and separate the two verdicts: was the reasoning sound, and was the outcome good. They come apart constantly, and a partner who cannot tell them apart will learn the wrong lesson from every exit.",
          "Mark against one thing: the assumption they did not name. Most weak venture reasoning is not wrong, it is unstated — and the habit worth building is saying out loud what would have to be true.",
          "Use the firm's own recorded decisions where they exist, with their dates. Teaching from the firm's real memos, including the ones that aged badly, is the most honest material available and costs nothing to obtain.",
          "For anything outside the firm's record, work from primary documents — the Form D, the filing, the company's own post — and cite them with a date. Never assert a round, a valuation or a metric about a real company from memory to make a case work.",
          "Say what cannot be taught this way. Judgement about a founder in a room is learned by being in rooms; label it as such rather than dressing a framework up as a substitute.",
          "Send anything current to Research. A lesson is about how to think; what is true about a market this month is somebody else's job and has to be evidenced.",
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
