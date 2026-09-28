/**
 * WHAT A CARD IS DOING RIGHT NOW, IN ONE PLACE (23 Sep 2026).
 *
 * Her words, approving the work-card redesign: "it's too much for a work home landing page. it
 * should be truly collapsed with only the title and in progress and the necessary things showing".
 *
 * The desk row, the expanded card and the card's own page each used to decide for themselves what
 * "in progress" meant. The row said "queued — picked up within 5 min" from `state` alone, the
 * Porter panel said "PLAN is running on …" from the Mac's run, and the card page said "step 0 of 8"
 * from a counter nothing on the desk read. Three readers, three answers, and on 23 Sep they
 * disagreed on the one card she was watching.
 *
 * So this is the ONE reader. It is pure: card + the run the Mac holds for it (if any) + the clock
 * → one status. Every surface calls it; none of them decides again.
 *
 * "WORKING NOW" IS A CLAIM ABOUT A MACHINE, NOT A LABEL. It is said only when something is
 * actually holding the card: a run on her Mac that is CLAIMED and has pinged within
 * `RUN_FRESH_MS`, or the Worker's own sweep holding the card's lease this minute. A card that is
 * merely between tries says "Waiting" and when the next try is; a run nobody has claimed says
 * "Queued for your Mac". The pulsing dot on screen is drawn from `kind === "WORKING_NOW"` and
 * nothing else.
 *
 * "NEEDS YOU" NAMES THE PERSON IT WAITS ON (27 Sep 2026). A block's `who` is a partner's first name
 * in capitals (`SEQUOIA` / `SCOOTER`, `shared/work/blocks.ts`), and after a hand-off it is moved to
 * the new primary (migration 0241). Until today every block read "Needs you" whoever it named, so
 * wc_77f52b33 — block_who SCOOTER, asked for by scooter@ — sat in her "Needs you" section and her
 * header count while nothing about it was hers to do. Now the reader asks the partner registry who
 * the card waits on: her, and it reads as before; the OTHER partner, and it reads "Needs Scooter",
 * sits with the worked cards and is counted apart from what needs her. Pinned from both seats in
 * `tests/workCardLiveStatus.test.ts`.
 */

import { partnerByEmail, partnerByFirmUserId, partnerByName, type Partner } from "../registry/partners";

export type LiveKind =
  /** Stopped on her: a block, nobody owns it, or it is hers to do. */
  | "NEEDS_YOU"
  /** Stopped on the OTHER partner: named, and never counted as hers. */
  | "NEEDS_PARTNER"
  /** She put it down herself; nothing works it until she releases it. */
  | "HELD"
  /** A machine is holding it this minute. The only kind that pulses. */
  | "WORKING_NOW"
  /** Between tries: nothing holds it, the sweep takes it again within five minutes. */
  | "WAITING"
  /** Asked for and not yet picked up — by the sweep, or by her Mac. */
  | "QUEUED"
  /** Her partner carries it. */
  | "WITH_PARTNER"
  | "DONE"
  | "STOPPED";

/** Which part of the desk the card belongs in. Decided here so the header counts what is drawn. */
export type LiveSection = "needs" | "worked" | "finished";

/** The run her Mac holds (or will hold) for the card — a `subscription_seat_run` row, narrowed. */
export interface LiveRun {
  status: string;
  run_kind?: string | null;
  claimed_by?: string | null;
  claimed_at?: string | null;
  progressed_at?: string | null;
  progress_note?: string | null;
  created_at?: string | null;
  /** The queue's own sentence about the row — a re-queued job says why it is back in the queue (28 Sep 2026). */
  resolution?: string | null;
}

/** The words `subscriptionSeats.ts` writes on a job put back in the queue because the Mac slept. Kept in step by a test. */
export const WAITING_FOR_MAC_WORDS = "waits for the Mac to wake";

export interface LiveStatusInput {
  /** The DISPLAY state: OPEN | IN_PROGRESS | BLOCKED | HELD | DONE | CANCELLED. */
  state: string;
  owner_type: string;
  owner_id: string | null;
  owner_name?: string | null;
  next_action?: string | null;
  work_attempts?: number | null;
  work_last_failure?: string | null;
  lease_until?: string | null;
  held_by_name?: string | null;
  held_reason?: string | null;
  block?: { stopped?: string | null; needed?: string | null; who?: string | null } | null;
  /**
   * WHO THE CARD WAITS ON (27 Sep 2026). `block_who` is the stored column (a partner's first name in
   * capitals, or ENGINEER; moved to the new primary by a hand-off, 0241) for a row that carries no
   * parsed `block`; `requested_by_email` is the PRIMARY partner — the only one who can approve a
   * plan or a preview (`partnerOwnership.ts`) — and the fallback when a block names nobody.
   */
  block_who?: string | null;
  requested_by_email?: string | null;
  secondary_partner_email?: string | null;
  current_run?: LiveRun | null;
  /**
   * A WEBSITE JOB'S STAGE, FROM ITS ROW (23 Sep 2026). When the card waits on her at the plan or the
   * preview, the line says so in words — "Preview ready · look and reply" — from these structured
   * facts, never from the stored block text ("PREVIEW READY. Look at it here: <six URLs>").
   */
  kind?: string | null;
  site_phase?: string | null;
  site_preview_url?: string | null;
  site_land_approved_at?: string | null;
  site_preview_only?: number | null;
  site_publish_ready?: number | null;
  site_check_state?: string | null;
  site_forced_by?: string | null;
  site_plan_filed_at?: string | null;
  site_plan_approved_at?: string | null;
}

/** Where a website job waits on her, if it does — read from the row, never from block text. */
export type SiteWait = "PREVIEW" | "PLAN" | null;

export function siteWait(card: LiveStatusInput): SiteWait {
  if (card.kind !== "WEB_PROPERTY_CHANGE") return null;
  if (["DONE", "CANCELLED", "HELD"].includes(card.state)) return null;
  const phase = (card.site_phase ?? "").toUpperCase();
  const gated = (card.site_preview_only === 1 || card.site_publish_ready === 0) && !card.site_forced_by;
  if ((phase === "BUILD" || phase === "LAND") && gated && !card.site_land_approved_at && card.site_check_state === "GREEN" && Boolean(card.site_preview_url)) return "PREVIEW";
  if (phase === "PLAN" && card.site_plan_filed_at && !card.site_plan_approved_at && card.state === "BLOCKED") return "PLAN";
  return null;
}

/**
 * A stored sentence in sentence case. Blocks and failures are written by several hands and some
 * shout ("PREVIEW READY."); the row never does.
 */
export function sentenceCase(text: string): string {
  const t = text.trim();
  if (!t) return t;
  const words = t.split(/(\s+)/);
  let i = 0;
  // Lower every leading ALL-CAPS word of two or more letters, then capitalise the first letter.
  while (i < words.length && (/^\s+$/.test(words[i]!) || /^[A-Z][A-Z'’-]+[.:,!]?$/.test(words[i]!))) {
    if (!/^\s+$/.test(words[i]!)) words[i] = words[i]!.toLowerCase();
    i += 1;
  }
  const out = words.join("");
  return out.charAt(0).toUpperCase() + out.slice(1);
}

/**
 * A FAILED TRY, SAID PLAINLY, WITH THE BLAME WHERE IT BELONGS (owner review, 23 Sep 2026). "Attempt
 * 1 of 3 did not get anywhere" is the sweep's own bookkeeping; to her it means our run stalled and
 * we tried again. Anything else keeps its words, in sentence case.
 */
export function plainFailure(text: string | null | undefined): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  const m = /^Attempt (\d+) of \d+ did not get anywhere\.?$/i.exec(t);
  if (m) {
    const n = Number(m[1]);
    const ord = ["First", "Second", "Third", "Fourth"][n - 1] ?? `Try ${n}`;
    return `${ord} try stalled on our side; retried automatically.`;
  }
  return t ? sentenceCase(t) : "";
}

export interface LiveStatus {
  kind: LiveKind;
  section: LiveSection;
  /** The one pill on the collapsed row. */
  pill: string;
  /** The one plain-English line beside it. */
  line: string;
  /** True only for WORKING_NOW — the pulsing dot. Kept as its own field so no reader re-derives it. */
  live: boolean;
  /** A card that has already failed once and is being retried. Never the same thing as "waiting". */
  failing: boolean;
  /**
   * The first name of the partner the card waits on when that partner is NOT the viewer
   * ("Scooter"); null otherwise. `deskSummary` groups the "needs Scooter" count by it.
   */
  waitsOn: string | null;
}

/**
 * How recently a claimed run must have spoken to count as working. The local-job claimer pings
 * every minute while its child runs (`scripts/claimer/local-job-claimer.mjs`); three minutes is two
 * missed pings, well inside the ten the reaper waits (`JOB_SILENCE_MS`) before handing it back.
 */
export const RUN_FRESH_MS = 3 * 60_000;

/** The sweep's promise, said the same way everywhere. */
export const NEXT_TRY = "Next try within 5 min";

const MAX_TRIES = 3;

function ms(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** "4 min", "1 hr 5 min" — how long something has been going. Never "0 min". */
export function sinceWords(iso: string | null | undefined, now: Date): string | null {
  const t = ms(iso);
  if (t === null) return null;
  const mins = Math.max(1, Math.round((now.getTime() - t) / 60_000));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
}

/**
 * One sentence, cut at a word — never mid-word. A block's "what would clear it" or a failure can
 * be a paragraph; the row carries its first sentence and the expanded card carries the rest.
 */
export function firstSentence(text: string | null | undefined, max = 110): string {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const stop = flat.search(/[.!?](\s|$)/);
  const sentence = stop >= 0 ? flat.slice(0, stop + 1) : flat;
  if (sentence.length <= max) return sentence.replace(/[.]$/, "");
  const cut = sentence.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.5 ? cut.slice(0, lastSpace) : cut).replace(/[,;:·—-]+$/, "")}…`;
}

function firstName(name: string | null | undefined): string {
  return (name ?? "").trim().split(/\s+/)[0] || "your partner";
}

/** The failure as a clause after "Next try within 5 min · ". */
function failureClause(text: string | null | undefined): string {
  const said = plainFailure(text);
  if (/retried automatically\.$/.test(said)) return said.replace(/\.$/, "").replace(/^./, (c) => c.toLowerCase());
  return `the last try failed: ${firstSentence(said, 90)}`;
}

/**
 * THE PARTNER A STOPPED CARD WAITS ON, FROM THE REGISTRY. The block's `who` first (the parsed block,
 * then the stored `block_who` column), because a hand-off moves it to the new primary (0241); a
 * block that names no partner waits on the primary — the only partner who can clear a plan or a
 * preview. Null when the card names an engineer or no partner at all; ENGINEER is not a partner and
 * is said as such by the caller.
 */
export function partnerWaitedOn(card: Pick<LiveStatusInput, "block" | "block_who" | "requested_by_email">): Partner | null {
  const named = (card.block?.who ?? card.block_who ?? "").trim();
  if (named.toUpperCase() === "ENGINEER") return null;
  return partnerByName(named) ?? partnerByEmail(card.requested_by_email) ?? null;
}

/**
 * "Needs you" or "Needs Scooter" — the pill for a stopped card, decided once. The other partner's
 * first name comes from the registry, never from the row's capitals.
 */
export function needsLabel(card: Pick<LiveStatusInput, "block" | "block_who" | "requested_by_email">, meId: string): { pill: string; waitsOn: string | null } {
  const partner = partnerWaitedOn(card);
  if (!partner || partner.firmUserId === partnerByFirmUserId(meId)?.firmUserId) return { pill: "Needs you", waitsOn: null };
  return { pill: `Needs ${partner.firstName}`, waitsOn: partner.firstName };
}

export function liveStatus(card: LiveStatusInput, meId: string, now: Date = new Date()): LiveStatus {
  const who = card.owner_name ?? "They";
  const failing = Boolean(card.work_last_failure) && !["BLOCKED", "DONE", "CANCELLED", "HELD"].includes(card.state);
  const base = { live: false, failing, waitsOn: null as string | null };
  const needs = needsLabel(card, meId);
  /** A stopped card, in the section and kind its addressee decides. */
  const stopped = (line: string): LiveStatus =>
    needs.waitsOn
      ? { ...base, failing: false, kind: "NEEDS_PARTNER", section: "worked", pill: needs.pill, line, waitsOn: needs.waitsOn }
      : { ...base, failing: false, kind: "NEEDS_YOU", section: "needs", pill: needs.pill, line };

  if (card.state === "DONE") return { ...base, kind: "DONE", section: "finished", pill: "Done", line: "Finished." };
  if (card.state === "CANCELLED") {
    return { ...base, kind: "STOPPED", section: "finished", pill: "Stopped", line: "Stopped on purpose. Kept on the record." };
  }
  if (card.state === "HELD") {
    const by = card.held_by_name ? firstName(card.held_by_name) : "You";
    const why = card.held_reason ? `: ${firstSentence(card.held_reason, 80)}` : "";
    return { ...base, kind: "HELD", section: "needs", pill: "On hold", line: `${by} put this on hold${why}. Nothing works it until it is released.` };
  }
  // A website job waiting at its plan or its preview is waiting on HER, in words — even when the
  // runner parked it as a block to hold it there.
  const wait = siteWait(card);
  if (wait === "PREVIEW") return stopped(needs.waitsOn ? `Preview ready · ${needs.waitsOn} looks and replies` : "Preview ready · look and reply");
  if (wait === "PLAN") return stopped(needs.waitsOn ? `Plan ready · ${needs.waitsOn} reads it and replies` : "Plan ready · read it and reply");
  if (card.state === "BLOCKED") {
    const what = sentenceCase(firstSentence(card.block?.needed || card.block?.stopped || card.next_action)) || "An answer before it can go on";
    // An engineer's block is still hers to escalate: it stays in her section, said as the engineer's.
    if ((card.block?.who ?? card.block_who) === "ENGINEER") return { ...base, kind: "NEEDS_YOU", section: "needs", pill: "Needs you", line: `Needs an engineer: ${what}` };
    return stopped(`${needs.pill}: ${what}`);
  }
  if (card.owner_type === "UNASSIGNED" || !card.owner_id) {
    return { ...base, kind: "NEEDS_YOU", section: "needs", pill: "Needs you", line: "Nobody has this yet: give it to someone." };
  }
  if (card.owner_type === "HUMAN") {
    if (card.owner_id === meId) {
      const next = firstSentence(card.next_action);
      return { ...base, kind: "NEEDS_YOU", section: "needs", pill: "Yours", line: next ? `Yours to do: ${next}` : "Yours to do. Nothing moves until you do it." };
    }
    const next = firstSentence(card.next_action);
    return {
      ...base,
      kind: "WITH_PARTNER",
      section: "worked",
      pill: `With ${firstName(card.owner_name)}`,
      line: next ? `${firstName(card.owner_name)} has it: ${next}` : `${firstName(card.owner_name)} has it.`,
    };
  }

  // An employee carries it. What is actually happening, in order of how sure we can be.
  const run = card.current_run ?? null;
  if (run && run.status === "CLAIMED") {
    const ping = ms(run.progressed_at) ?? ms(run.claimed_at);
    if (ping !== null && now.getTime() - ping <= RUN_FRESH_MS) {
      const doing = run.progress_note ? `: ${firstSentence(run.progress_note, 70)}` : "";
      const since = sinceWords(run.claimed_at ?? run.progressed_at, now);
      return {
        ...base,
        live: true,
        kind: "WORKING_NOW",
        section: "worked",
        pill: "Working now",
        line: `${who} is working on your Mac${doing}${since ? ` · ${since}` : ""}`,
      };
    }
    return {
      ...base,
      kind: "WAITING",
      section: "worked",
      pill: "Waiting",
      line: `Your Mac went quiet on this run · it is handed back and tried again on its own`,
    };
  }
  if (run && run.status === "QUEUED") {
    const since = sinceWords(run.created_at, now);
    /*
     * THE MAC SLEPT MID-RUN (28 Sep 2026): the job is back in the queue by the reaper's hand, not
     * a failed attempt and not a block. Said as what it is — a wait — so a card that looks like
     * this is never mistaken for one that needs her.
     */
    if (typeof run.resolution === "string" && run.resolution.includes(WAITING_FOR_MAC_WORDS)) {
      return {
        ...base,
        kind: "WAITING",
        section: "worked",
        pill: "Waiting",
        line: `Your Mac went to sleep mid-run · it waits and is picked up again when the Mac wakes${since ? ` · ${since}` : ""}`,
      };
    }
    return { ...base, kind: "QUEUED", section: "worked", pill: "Queued", line: `Queued for your Mac${since ? ` · waiting ${since}` : ""}` };
  }
  const lease = ms(card.lease_until);
  if (lease !== null && lease > now.getTime()) {
    return { ...base, live: true, kind: "WORKING_NOW", section: "worked", pill: "Working now", line: `${who} is working on it now` };
  }
  if (failing) {
    return {
      ...base,
      kind: "WAITING",
      section: "worked",
      pill: "Waiting",
      line: `${NEXT_TRY} · ${failureClause(card.work_last_failure)}`,
    };
  }
  if (card.state === "OPEN" && (card.work_attempts ?? 0) === 0) {
    return { ...base, kind: "QUEUED", section: "worked", pill: "Queued", line: "Queued · picked up within 5 min" };
  }
  return { ...base, kind: "WAITING", section: "worked", pill: "Waiting", line: `${NEXT_TRY} · try ${Math.min(MAX_TRIES, Math.max(1, card.work_attempts ?? 1))} of ${MAX_TRIES} so far` };
}

/**
 * THE HEADER, COUNTED FROM WHAT IS DRAWN. On 23 Sep the masthead said "One thing is stopped until
 * you answer" while the card it meant was merely unowned — a different list with its own idea of
 * "waiting". The header now counts the statuses the sections are drawn from, so the sentence and
 * the sections cannot disagree.
 */
export interface DeskSummary {
  needsYou: number;
  /** Stopped on the OTHER partner — named in the line ("1 needs Scooter"), never in `needsYou`. */
  needsPartner: number;
  beingWorked: number;
  waiting: number;
  queued: number;
  failing: number;
  line: string;
  /** Nothing needs her and nothing is failing — the good tone. */
  clear: boolean;
}

export function deskSummary(statuses: readonly LiveStatus[], decisions = 0): DeskSummary {
  let needsYou = decisions;
  let needsPartner = 0;
  const byPartner = new Map<string, number>();
  let beingWorked = 0;
  let waiting = 0;
  let queued = 0;
  let failing = 0;
  for (const s of statuses) {
    if (s.failing) failing += 1;
    if (s.section === "needs") needsYou += 1;
    else if (s.kind === "NEEDS_PARTNER") {
      needsPartner += 1;
      const name = s.waitsOn ?? "your partner";
      byPartner.set(name, (byPartner.get(name) ?? 0) + 1);
    } else if (s.kind === "WORKING_NOW" || s.kind === "WITH_PARTNER") beingWorked += 1;
    else if (s.kind === "WAITING") waiting += 1;
    else if (s.kind === "QUEUED") queued += 1;
  }
  const parts = [needsYou === 0 ? "Nothing needs you" : `${needsYou} need${needsYou === 1 ? "s" : ""} you`];
  for (const [name, n] of byPartner) parts.push(`${n} need${n === 1 ? "s" : ""} ${name}`);
  if (beingWorked > 0) parts.push(`${beingWorked} being worked`);
  if (waiting > 0) parts.push(`${waiting} waiting for ${waiting === 1 ? "its" : "their"} next try`);
  if (queued > 0) parts.push(`${queued} queued`);
  return { needsYou, needsPartner, beingWorked, waiting, queued, failing, line: parts.join(" · "), clear: needsYou === 0 && failing === 0 };
}
