import { PREVIEW_PARTNER, partnerByEmail } from "../registry/partners";

/**
 * PREVIEW MODE — run the real thing, show her the real output, let nothing out of the building
 * (17 Sep 2026).
 *
 * Operator, on the hire search due to reach Scooter for the first time on Monday: she wants to see
 * Monday's email before Monday. Not a mock-up of it — the actual note, from the actual search, with
 * the actual candidates. And not only for this one job: "any scheduled job or work card, any AI
 * employee, runnable in preview."
 *
 * ─── THE FIVE PROPERTIES, AND WHERE EACH ONE IS ENFORCED ───────────────────────────────────────
 *
 *   1 · IT DOES THE REAL WORK. Real searches, real model calls, the real rendered deliverable. A
 *       simulated preview tells her nothing about what the recipient actually gets. Nothing in the
 *       runner is stubbed and no prompt is shortened.
 *
 *   2 · THE RECIPIENT BECOMES SEQUOIA, whoever the work was addressed to, with a header naming
 *       whose preview it is and who would normally have received it. `previewHeader` below writes
 *       that header; `applyPreviewBoundary` in `worker/effects/emailTransport.ts` applies it.
 *
 *   3 · NO EXTERNAL EFFECTS, EVER — AT THE SEND BOUNDARY, NOT PER FEATURE. This is the property
 *       that has to be structural, because a rule each feature remembers is a rule the next feature
 *       forgets. Both transports (`sendViaResend`, `sendViaCloudflare`) call
 *       `applyPreviewBoundary` before they touch a network or a binding, and it REPLACES the
 *       recipient list with exactly one address: Sequoia's. There is no branch through either
 *       transport that can carry a preview to anybody else. `executeExternalEffect` refuses a
 *       preview outright, so the approved-receipt path — the one that can reach founders, LPs and
 *       journalists — never runs at all, and no receipt is consumed.
 *       `scripts/validate/preview-sends-nowhere.mjs` fails the build if a transport is added that
 *       does not pass through the boundary.
 *
 *   4 · IT MUST NOT CONSUME THE REAL RUN. Previewing this week's hire search must not leave
 *       Scooter's Monday card already done. `worker/services/preview.ts` runs the work against a
 *       database handle that answers every read for real and performs no write except to the tables
 *       that record what a model call cost. So the search runs, the pages are checked, the note is
 *       rendered — and no card moves, no candidate is remembered, no deliverable is filed and no
 *       notice is raised.
 *
 *   5 · IT COSTS MONEY AND COUNTS AGAINST THE CAPS. A real run is a real run. The AI accounting
 *       tables are the deliberate exception to the write block above, so a preview is budgeted,
 *       priced and attributed exactly as the Monday run will be — and if it takes the firm over a
 *       cap, the cap stops it. `PREVIEW_COST_NOTICE` is on the page and in the header of every
 *       preview email, because a cost she cannot see is a cost she will be surprised by.
 */

/** The only address a preview can ever reach. Asked of the partner registry, never typed. */
export const PREVIEW_RECIPIENT = PREVIEW_PARTNER.email;

/** Said where she reads it, on the page and in the mail. Property 5 above. */
export const PREVIEW_COST_NOTICE =
  "This preview did the real work: real searches, real model calls, the real note. It cost real money and it counts against the firm's caps, exactly like the scheduled run will.";

export type PreviewTargetKind = "JOB" | "CARD";

export interface PreviewRequest {
  kind: PreviewTargetKind;
  /** A `scheduled_job.job_key`, or a `work_card.id`. */
  key: string;
}

/** Everything a preview knows about itself, carried on the env and read by the send boundary. */
export interface PreviewContext {
  id: string;
  /** The `firm_user.id` who asked for it. Always a partner; the route refuses anybody else. */
  requestedBy: string;
  requestedByEmail: string;
  target: PreviewRequest;
  /** What the work is, in words — "Walker's weekly hire search for West Peek Productions". */
  what: string;
  startedAt: string;
}

/**
 * The header that goes at the top of every previewed email.
 *
 * SAYS BOTH NAMES, and that is the point rather than a courtesy: a preview of Scooter's note
 * arriving in Sequoia's inbox is indistinguishable from a bug unless the first line says whose
 * preview it is and who would normally have received it. `normallyTo` is the address the work
 * ACTUALLY asked for, read at the boundary from the payload before it was rewritten — not a
 * guess and not a parameter a caller could get wrong.
 */
export function previewHeader(input: {
  normallyTo: readonly string[];
  what: string;
  requestedByEmail: string;
}): string {
  const who = input.normallyTo.map((a) => partnerByEmail(a)?.fullName ?? a).join(" and ");
  return [
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    `PREVIEW — this is not a live send. Requested by ${input.requestedByEmail}.`,
    `Normally goes to: ${who || "nobody"}. Sent here instead, and to nobody else.`,
    `What it is: ${input.what}`,
    "",
    PREVIEW_COST_NOTICE,
    "Nothing on the recipient's desk changed: no card was closed, nothing was filed, and the",
    "scheduled run still has all its work to do.",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "",
  ].join("\n");
}

/** The same header for the HTML part, when the composer made one. */
export function previewHeaderHtml(input: {
  normallyTo: readonly string[];
  what: string;
  requestedByEmail: string;
}): string {
  const escape = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lines = previewHeader(input)
    .split("\n")
    .filter((l) => l.trim().length > 0 && !l.startsWith("━"));
  return [
    '<div style="border:2px solid #b45309;background:#fffbeb;color:#7c2d12;padding:16px;margin:0 0 20px;font-family:system-ui,sans-serif;font-size:14px;line-height:1.5;">',
    ...lines.map((l) => `<p style="margin:0 0 8px;">${escape(l)}</p>`),
    "</div>",
  ].join("");
}

/** The subject a preview goes out under, so it is never mistaken for the real note in a mailbox. */
export function previewSubject(subject: string): string {
  return subject.startsWith("[PREVIEW]") ? subject : `[PREVIEW] ${subject}`;
}

/**
 * The card a scheduled job would open, so a preview can run the work without opening one.
 *
 * WHY A TABLE RATHER THAN CALLING THE OPENER. A job's opener INSERTS the card and then reads it
 * back, so under the preview's write block it would read back nothing and the preview would die
 * where the real run works. Opening the card for real is worse: a real card on Walker's desk is
 * claimed by the real sweep minutes later and Scooter gets the live email — the preview would
 * literally consume the run it exists to avoid consuming.
 *
 * So a preview synthesises the card instead. Everything downstream — the runner, the steer, the
 * search, the judgement, the rendering — is the real code path taking a real-shaped card.
 *
 * A JOB WITH NO ENTRY STILL PREVIEWS: it runs its own tick, which for the intelligence and sweep
 * jobs is the whole job. The entries below are for the jobs whose tick only OPENS a card and whose
 * real work happens in the sweep afterwards. `scripts/validate/preview-sends-nowhere.mjs` checks
 * that every card-opening job key is present here, so a new one cannot be added and silently
 * preview nothing.
 */
export interface PreviewCardShape {
  /** The `work_card.kind` the sweep dispatches on. */
  cardKind: string;
  /** The `ai_employee.id` that owns it. */
  ownerId: string;
  /** In words, for the preview header and the page. */
  what: string;
  /** The title the real card would carry, so the preview names the same week or month. */
  title: (now: Date) => string;
}

/** Filled by the worker side, which owns the title builders. Kept as a type here for the client. */
export const CARD_OPENING_JOB_KEYS: readonly string[] = [
  "productions_hire_search",
  "productions_monthly",
  "productions_customer_ideas",
  "productions_press_pitches",
];
