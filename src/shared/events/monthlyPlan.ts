/**
 * ONE TOPIC A MONTH, PER STREAM — and the concepts are angles on it (17 Sep 2026).
 *
 * ─── What was wrong ────────────────────────────────────────────────────────────────────────────
 *
 * A packet compared three different SUBJECTS and picked one. The October Workshop packet put a
 * task-triage session against an AI back-office build against a third, and called all three
 * "concepts". Three subjects is not a comparison; it is three proposals wearing one word, and the
 * two that lose are simply thrown away.
 *
 * Operator, 17 Sep 2026: "Black lawyers is a topic. Community is a topic. but angles are things
 * like names / venues / type of event and for workshops the angles can be 'Community as a Service'
 * the new model OR How to find your Brand's community."
 *
 * So: the TOPIC is fixed for the month before any ideation happens, and an ANGLE varies the name,
 * the venue, the format, the framing, the experience — never the subject.
 *
 * ─── Why this file exists, rather than a table ─────────────────────────────────────────────────
 *
 * `WORKSHOP_SERIES` already held two months in code, and said why: a decision the partners made
 * once, and a row an admin path could edit would make it look revisable from a screen. That
 * reasoning still holds, so the plan stays in code — but there were about to be FOUR lists of it
 * (Workshop titles here, Room topics nowhere, the externally-hosted month nowhere, the
 * "Parker's own pick" months implied by absence). "Two components each keeping their own list
 * with no link" is the defect class this repo names, so there is now exactly one list, it covers
 * BOTH streams, and `WORKSHOP_SERIES` is derived from it rather than kept beside it.
 *
 * ─── What the plan has to be able to say ───────────────────────────────────────────────────────
 *
 *   SET            a human handed Parker the topic in advance; he builds angles on it.
 *   PARKER_CHOOSES nobody did; he picks the topic HIMSELF, brings something new, and never waits,
 *                  never blocks, and never asks which situation he is in. Both paths run with no
 *                  human present — the difference is one string being present or absent.
 *   EXTERNAL       somebody outside the firm is running that month's session. It is not Parker's
 *                  to build, AND it is the thing adjacency must measure against, because what
 *                  actually runs is what the next month must not repeat.
 *   NOT_RUNNING    that stream has no session that month. Recorded rather than left absent, so
 *                  "no Room ran in September" is a fact in the plan instead of a silence that
 *                  reads identically to "nobody has written it down yet".
 */

export const STREAMS = ["ROOM", "WORKSHOP"] as const;
export type Stream = (typeof STREAMS)[number];

export type PlanStatus = "SET" | "PARKER_CHOOSES" | "EXTERNAL" | "NOT_RUNNING";

export interface MonthPlan {
  /** YYYY-MM. */
  month: string;
  stream: Stream;
  status: PlanStatus;
  /**
   * THE ONE SUBJECT for that month and stream. Null when Parker picks it (PARKER_CHOOSES) or when
   * there is nothing to pick (NOT_RUNNING). For EXTERNAL it is what the session is actually about,
   * which is the only reason adjacency can be honest about a month the firm did not build.
   */
  topic: string | null;
  /**
   * What the partners want out of the ANGLES, in their own words. Carried into the prompt verbatim
   * — the receipt rule: what she typed is what the model is given.
   */
  steer: string | null;
  /** Who is running it, when it is not the firm. */
  host: string | null;
}

/**
 * THE PLAN. Everything here is the operator's, recorded on the date beside it.
 *
 * Kept as a flat list rather than a nested record because "every month/stream pair that has been
 * decided" is the question everything asks of it, and a nested shape makes the EXTERNAL and
 * NOT_RUNNING rows easy to forget to write.
 */
export const MONTHLY_PLAN: readonly MonthPlan[] = [
  // ── September 2026 ──────────────────────────────────────────────────────────────────────────
  {
    month: "2026-09",
    stream: "WORKSHOP",
    status: "SET",
    topic: "How to use AI for small businesses / solopreneurs",
    steer: null,
    host: null,
  },
  {
    // "no Room ran in September and none runs in October" (17 Sep 2026).
    month: "2026-09",
    stream: "ROOM",
    status: "NOT_RUNNING",
    topic: null,
    steer: null,
    host: null,
  },

  // ── October 2026 ────────────────────────────────────────────────────────────────────────────
  {
    /*
     * NOT PARKER'S, AND THIS ROW IS WHAT KEEPS ADJACENCY HONEST.
     *
     * Operator: "October is not his — externally hosted by a friend of Scooter's, and it is about
     * content creation." Without this row, adjacency for November reads Parker's own DECLINED
     * October AI packet, so November carefully avoids a dead idea and walks straight into the
     * subject that is actually being run.
     */
    month: "2026-10",
    stream: "WORKSHOP",
    status: "EXTERNAL",
    topic: "Content creation",
    steer: null,
    host: "a friend of Scooter's",
  },
  {
    month: "2026-10",
    stream: "ROOM",
    status: "NOT_RUNNING",
    topic: null,
    steer: null,
    host: null,
  },

  // ── November 2026 ───────────────────────────────────────────────────────────────────────────
  {
    /*
     * Her topic, given in advance. It REPLACES the old `WORKSHOP_SERIES` entry "How to build
     * community", which was a title rather than a topic — and a title is already one angle, so
     * holding it as the topic left nothing for the angles to vary.
     */
    month: "2026-11",
    stream: "WORKSHOP",
    status: "SET",
    topic: "Community",
    steer:
      "Angles on how companies and brands leverage community to achieve their goals. Her own examples of what an angle " +
      'is: "Community as a Service" — the new model — OR "How to find your Brand\'s community".',
    host: null,
  },
  {
    /*
     * The same topic she declined once, with better angles. She declined `rpk_6828fcf0` ("The Rise
     * of the Black Lawyer Room") on 15 Sep 2026 — the TOPIC was never the problem.
     */
    month: "2026-11",
    stream: "ROOM",
    status: "SET",
    topic: "Black lawyers",
    steer:
      "She declined the first attempt at this topic on 15 Sep 2026 — packet rpk_6828fcf0, \"The Rise of the Black Lawyer " +
      "Room\". The topic was never the problem, the angles were. This time: several DISTINCT name ideas, catchy, and " +
      "unique experiences that draw both the people and the sponsors. Do not propose that title again.",
    host: null,
  },

  // ── December 2026 ───────────────────────────────────────────────────────────────────────────
  {
    month: "2026-12",
    stream: "WORKSHOP",
    status: "PARKER_CHOOSES",
    topic: null,
    steer: "Something new. Not Black lawyers again, and not November's topic again.",
    host: null,
  },
  {
    month: "2026-12",
    stream: "ROOM",
    status: "PARKER_CHOOSES",
    topic: null,
    steer: "Something new. Not Black lawyers again, and not November's topic again.",
    host: null,
  },
];

/** The plan for one month and stream, or null when nobody has written one. */
export function planFor(month: string, stream: Stream): MonthPlan | null {
  return MONTHLY_PLAN.find((p) => p.month === month && p.stream === stream) ?? null;
}

/**
 * THE MONTH'S TOPIC AND WHERE IT CAME FROM — the one question the chain asks before it ideates.
 *
 * Three inputs, in order, and the order IS the rule in item 3: a partner's plan entry wins; then
 * whatever a human typed into the request form; then Parker chooses. There is no fourth branch in
 * which he waits, because there is no state in which nothing is decided.
 */
export function topicFor(
  month: string,
  stream: Stream,
  typed?: string | null,
): { topic: string | null; setBy: "PARTNERS" | "PARKER"; steer: string | null; plan: MonthPlan | null } {
  const plan = planFor(month, stream);
  if (plan?.status === "SET" && plan.topic) return { topic: plan.topic, setBy: "PARTNERS", steer: plan.steer, plan };
  const handed = typed?.trim();
  if (handed) return { topic: handed, setBy: "PARTNERS", steer: plan?.steer ?? null, plan };
  return { topic: null, setBy: "PARKER", steer: plan?.steer ?? null, plan };
}

/**
 * The Workshop months the partners set, derived rather than kept beside the plan.
 *
 * Callers that only ever asked "is this month's Workshop title fixed" keep working, and there is
 * no second list to update. A month the plan marks EXTERNAL or NOT_RUNNING is deliberately NOT in
 * here: it is not a title Parker builds to.
 */
export const WORKSHOP_SERIES: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    MONTHLY_PLAN.filter((p) => p.stream === "WORKSHOP" && p.status === "SET" && p.topic).map((p) => [p.month, p.topic!]),
  ),
);

// ── Adjacency ──────────────────────────────────────────────────────────────────────────────────

/**
 * ONE MONTH BACK, AND SOFT.
 *
 * Operator: "adjacency is a light rule. for one month. and just make sure they are not too
 * similar." So: look at the month immediately before, and refuse a near-identical subject. It is
 * guidance in the prompt rather than a rejection in the parser, because the rule she described is
 * "not too similar" — a judgement — and a deterministic check on a judgement would either block
 * legitimate work or pass everything.
 */
export const ADJACENCY_MONTHS_BACK = 1;

/**
 * The months the adjacency rule looks at — derived from `ADJACENCY_MONTHS_BACK` so the window is
 * the constant rather than a hardcoded `[previousMonth(m)]` in two files.
 */
export function adjacencyWindow(month: string): string[] {
  const out: string[] = [];
  let m = month;
  for (let i = 0; i < ADJACENCY_MONTHS_BACK; i += 1) {
    m = previousMonth(m);
    out.push(m);
  }
  return out;
}

/** The YYYY-MM immediately before this one. */
export function previousMonth(month: string): string {
  const [y, m] = month.split("-").map((n) => Number(n));
  if (!y || !m) return month;
  const d = m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 };
  return `${d.y}-${String(d.m).padStart(2, "0")}`;
}

/**
 * What the adjacency rule is measured against, from the plan alone: subjects that are RUNNING in
 * the window, whoever is running them. The service adds what the record says actually ran (kept
 * packets and calendared events); this half is the part the record cannot know, because an
 * externally hosted session was never a packet here.
 */
export function plannedSubjectsNear(month: string, stream: Stream): Array<{ month: string; topic: string; note: string }> {
  const window = adjacencyWindow(month);
  return MONTHLY_PLAN.filter(
    (p) => p.stream === stream && window.includes(p.month) && p.topic && (p.status === "SET" || p.status === "EXTERNAL"),
  ).map((p) => ({
    month: p.month,
    topic: p.topic!,
    note: p.status === "EXTERNAL" ? `hosted by ${p.host ?? "someone outside the firm"} — it is still what ran` : "the firm ran it",
  }));
}

// ── The cadence ────────────────────────────────────────────────────────────────────────────────

/**
 * BOTH STREAMS DELIVER ON THE 1st OF THE MONTH PRIOR. November's lands 1 October.
 *
 * Operator, 17 Sep 2026. The monthly job already minted the FOLLOWING month's cards whenever that
 * month had none, which lands on the 1st as a side effect of the month rolling over — true, and
 * true by accident. Stated here so the trigger is a named rule with a test on it rather than an
 * emergent property of a guard, and so the job can say "delivering November's, due 1 October"
 * rather than "the following month happens to be empty".
 *
 * IT IS A FLOOR, NOT A WINDOW. A tick on the 3rd because the 1st was missed still delivers: a
 * cadence that only fires on one exact day is a cadence that silently skips a month the first time
 * a cron is late, and this system has already had work sit unqueued.
 */
export const DELIVERY_DAY_OF_MONTH = 1;

/** The month both streams are delivering for, as of `now`: the month after this one. */
export function deliveryMonth(nowIso: string): string {
  const d = new Date(nowIso);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 2; // +1 for 1-based, +1 for "the following month"
  return m > 12 ? `${y + 1}-01` : `${y}-${String(m).padStart(2, "0")}`;
}

/**
 * The date that month's packets were due: `DELIVERY_DAY_OF_MONTH` of the month prior.
 *
 * Derived from the constant rather than written as "-01", for the same reason the Workshop's length
 * is interpolated: a date typed into a string is a second copy of the rule, and the second copy is
 * the one that goes stale.
 */
export function dueOn(month: string): string {
  return `${previousMonth(month)}-${String(DELIVERY_DAY_OF_MONTH).padStart(2, "0")}`;
}

// ── Angles ─────────────────────────────────────────────────────────────────────────────────────

/**
 * WHAT MAY VARY BETWEEN TWO ANGLES ON THE SAME TOPIC. Closed, because the point of the vocabulary
 * is that SUBJECT is not in it.
 */
export const ANGLE_KINDS = ["NAME", "FRAMING", "FORMAT", "VENUE", "EXPERIENCE", "AUDIENCE_CUT"] as const;
export type AngleKind = (typeof ANGLE_KINDS)[number];

export function angleKindOf(v: unknown): AngleKind {
  const s = typeof v === "string" ? v.trim().toUpperCase().replace(/[\s-]+/g, "_") : "";
  return (ANGLE_KINDS as readonly string[]).includes(s) ? (s as AngleKind) : "FRAMING";
}

/**
 * Two subject strings compared the only way a machine honestly can: as the same string, once case,
 * punctuation and spacing stop mattering. Used to REJECT a packet whose concepts each declared a
 * different subject — not to judge whether two subjects are "similar", which is the prompt's job.
 */
export function sameSubject(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (s: string | null | undefined): string =>
    (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const left = norm(a);
  return left.length > 0 && left === norm(b);
}

/**
 * The rule, in the words a model is given it in — with her own example, because the example is what
 * makes the distinction land. Shared by the Room and the Workshop prompts so there is one statement
 * of it, and so a change to the rule cannot reach one stream and not the other.
 */
export function angleRules(input: { topic: string; stream: Stream; setBy: "PARTNERS" | "PARKER" }): string {
  const thing = input.stream === "WORKSHOP" ? "Workshop" : "Room";
  return [
    `THE TOPIC IS ONE SUBJECT AND IT IS ALREADY DECIDED: "${input.topic}".`,
    input.setBy === "PARTNERS"
      ? "A partner set it. It is not up for discussion and you do not replace it."
      : "You chose it yourself because nobody handed you one. Having chosen it, it is fixed for this packet.",
    "",
    "THE THREE CONCEPTS ARE THREE ANGLES ON THAT ONE SUBJECT — NOT three different subjects.",
    "An angle varies the NAME, the FRAMING, the FORMAT, the VENUE, the EXPERIENCE or which cut of the",
    "audience it is aimed at. An angle NEVER varies what the session is about.",
    "",
    "The partner's own example, verbatim: \"Black lawyers is a topic. Community is a topic. but angles",
    "are things like names / venues / type of event and for workshops the angles can be 'Community as",
    "a Service' the new model OR How to find your Brand's community.\"",
    "",
    `So for the topic "${input.topic}": three different names, framings, formats or experiences for the`,
    `same ${thing} — each one something a person could be invited to, all of them about "${input.topic}".`,
    "",
    "EVERY concept MUST carry `angle_on` set to the topic above, copied EXACTLY, and `angle_kind` from",
    `${ANGLE_KINDS.join(" / ")} saying what this angle varies. A concept whose \`angle_on\` is anything`,
    "else is a second subject, and the whole answer is DISCARDED and asked for again.",
  ].join("\n");
}
