/**
 * OUTSIDE EMAIL: WHAT MAY SEND (owner ruling, 23 Oct 2026).
 *
 * Owner, verbatim: "We need a universal narrow switch and i can easily go in the ui and tell it
 * which jobs or work cards to allow".
 *
 * THREE LAYERS, ONE ANSWER. An employee's email to anybody outside the firm goes only when ALL of:
 *   1 · the break-glass kill switch is not pulled — `WP_OS_OUTSIDE_EMAIL_BREAK_GLASS = "off-hard"`
 *       in wrangler.toml stops every one, whatever the list says;
 *   2 · the master switch in D1 is "Only what I allow" (there is no "everything" state — the
 *       database refuses one and so does this code);
 *   3 · the job, or the work card, is on her list.
 * Default: the list is empty, so nothing is allowed.
 *
 * NOT THE ONLY LOCK. Allowing a job never sends anything by itself: every email still needs its own
 * approved receipt, and the Learning Club still needs its content-hash approvals and its own switch.
 *
 * ONE FUNCTION DECIDES. `outsideEmailAllowed` (src/worker/services/outsideEmail.ts) reads the state
 * and calls `decideOutsideEmail` below. Every outward send path asks it; the validator
 * `scripts/validate/outside-email-one-door.mjs` fails a path that does not.
 */

/** The break-glass variable. Exactly "off-hard" stops everything; any other value leaves the list in charge. */
export const BREAK_GLASS_VAR = "WP_OS_OUTSIDE_EMAIL_BREAK_GLASS";
export const BREAK_GLASS_VALUE = "off-hard";

export type OutsideEmailMode = "OFF" | "ONLY_ALLOWED";
export const OUTSIDE_EMAIL_MODES: readonly OutsideEmailMode[] = ["OFF", "ONLY_ALLOWED"];

export interface OutsideEmailJob {
  /** Stored in `outside_email_allow.item_id` and `external_effect_request.outside_job`. */
  id: string;
  /** Plain words, for her. */
  name: string;
  employee: string;
  sends: string;
  to: string;
  /** What still has to happen before any one email goes, even when allowed. */
  stillNeeds: string;
}

/**
 * EVERY JOB THAT CAN EMAIL OUTSIDE THE FIRM. One list: the screen renders it, the API accepts only
 * these ids, and the validator fails any `outside_job` written in code that is not here.
 */
export const OUTSIDE_EMAIL_JOBS: readonly OutsideEmailJob[] = [
  {
    id: "tlc_brand_sales",
    name: "TLC brand sales",
    employee: "Wynn",
    sends: "Short sales emails asking a brand to sponsor a Learning Club evening: four at most per brand, a few a day.",
    to: "One marketing contact at each brand, at an address found on the brand's own web page.",
    stillNeeds: "Each email still waits for your approval on Approvals, and the TLC brand pitch, playbook and \"Start sending\" step all stay.",
  },
];

export const TLC_BRAND_SALES_JOB = "tlc_brand_sales";

export function outsideEmailJob(id: string | null | undefined): OutsideEmailJob | null {
  return OUTSIDE_EMAIL_JOBS.find((j) => j.id === id) ?? null;
}

export interface OutsideEmailState {
  breakGlass: boolean;
  mode: OutsideEmailMode;
  allowedJobs: ReadonlySet<string>;
  allowedCards: ReadonlySet<string>;
}

export interface OutsideEmailAsk {
  job?: string | null;
  cardId?: string | null;
}

export type OutsideEmailCode = "ALLOWED" | "BREAK_GLASS" | "MODE_OFF" | "NOT_ON_LIST";

export interface OutsideEmailDecision {
  allowed: boolean;
  code: OutsideEmailCode;
  /** Phrased for her, not for a log. */
  reason: string;
}

export function breakGlassPulled(env: Record<string, unknown>): boolean {
  return env[BREAK_GLASS_VAR] === BREAK_GLASS_VALUE;
}

/** Anything but exactly ONLY_ALLOWED reads as OFF. A missing row, a typo, "EVERYTHING": all off. */
export function readMode(raw: string | null | undefined): OutsideEmailMode {
  return raw === "ONLY_ALLOWED" ? "ONLY_ALLOWED" : "OFF";
}

export function decideOutsideEmail(state: OutsideEmailState, ask: OutsideEmailAsk): OutsideEmailDecision {
  if (state.breakGlass) {
    return { allowed: false, code: "BREAK_GLASS", reason: "Outside email is stopped by the break-glass switch. Nothing goes outside the firm." };
  }
  if (state.mode !== "ONLY_ALLOWED") {
    return { allowed: false, code: "MODE_OFF", reason: "Outside email is off. Nothing goes outside the firm." };
  }
  const job = outsideEmailJob(ask.job);
  if (job && state.allowedJobs.has(job.id)) return { allowed: true, code: "ALLOWED", reason: `${job.name} is on your Outside email list.` };
  if (ask.cardId && state.allowedCards.has(ask.cardId)) return { allowed: true, code: "ALLOWED", reason: "This card is on your Outside email list." };
  if (job) return { allowed: false, code: "NOT_ON_LIST", reason: `${job.name} is not on your Outside email list.` };
  if (ask.cardId) return { allowed: false, code: "NOT_ON_LIST", reason: "This card is not on your Outside email list." };
  return { allowed: false, code: "NOT_ON_LIST", reason: "This email is not tied to a job or card on your Outside email list." };
}

/**
 * EVERY FILE THAT PUTS AN EMAIL ON THE WIRE, AND WHY IT MAY. Read by the validator
 * (`scripts/validate/outside-email-one-door.mjs`) and by `tests/outsideEmail.test.ts`, which both scan
 * `src/` for transport calls: a file that calls a transport and is not here fails, and a GOVERNED
 * file that does not ask `outsideEmailAllowed` before it sends fails. Add a sender → add it here,
 * with its kind, or the build is red.
 *
 *   TRANSPORT       defines a transport; sends only what a caller below hands it.
 *   GOVERNED        an employee's email to somebody outside the firm: asks `outsideEmailAllowed`.
 *   BEHIND_GOVERNED reached only from a GOVERNED file, after its check (the partner's own Gmail).
 *   PARTNERS_ONLY   refuses any address that is not one of the two partners.
 *   HUMAN_RELEASED  a partner pressed "Send it" on these exact words; a person's own send.
 */
export const OUTWARD_SEND_PATHS = [
  { file: "src/worker/effects/resendClient.ts", kind: "TRANSPORT" },
  { file: "src/worker/effects/cloudflareEmailClient.ts", kind: "TRANSPORT" },
  { file: "src/worker/effects/googleClient.ts", kind: "TRANSPORT" },
  { file: "src/worker/effects/executor.ts", kind: "GOVERNED" },
  { file: "src/worker/services/googleConnect.ts", kind: "BEHIND_GOVERNED" },
  { file: "src/worker/services/execEmail.ts", kind: "PARTNERS_ONLY" },
  { file: "src/worker/services/previewApproval.ts", kind: "HUMAN_RELEASED" },
] as const;
