/**
 * A page's guide — the one description of a page that cannot drift from the page.
 *
 * WHY THIS EXISTS. On 19 Sep 2026 the owner asked Walter on Meetings how the page works. He answered
 * from `pagePurpose.ts`, which still said "Prepare for a meeting · Confer with an AI employee during
 * it · Run a close-out" — the page as it was before that week's redesign gave it three faces, a
 * room, a Meet band and one approval card. Nothing failed, because the description was prose and
 * nothing read it against the page. Her words: "I can't understand anything he said — it's all
 * jumbled … also I think he still has the old page instructions."
 *
 * THE RULE. A guide names the page's bands and controls BY THE STRINGS THE PAGE EMITS — the
 * `data-testid` and the visible label — and `npm run validate:page-guides` fails the build when a
 * guide names something the page no longer renders, or the page renders a primary act the guide
 * does not mention. A guide is therefore not documentation; it is a contract the page is held to,
 * and the host's "how does this page work" answer is composed from it rather than from the model's
 * memory of an older page.
 *
 * WRITING RULE. Plain words a partner says out loud. `label` is the button's text exactly as it
 * appears; `does` is what pressing it does; `then` is what happens next (a card raised, a page
 * opened, a job started); `who` is who may press it. No schema vocabulary — the reader is on a
 * phone, asking a colleague.
 */

export interface GuideBand {
  /** The band's heading as the page shows it. */
  name: string;
  /** The `data-testid` of the band's container, exact or a template prefix ending in `-`. */
  testid?: string;
  /** One line: what the band shows. */
  shows: string;
}

export interface GuideAct {
  /** The control's visible label, exactly as rendered. */
  label: string;
  /**
   * The `data-testid` the page gives the control, exact or a template prefix ending in `-`.
   * Omit only for a control that has none — the label must then appear verbatim in the source.
   */
  testid?: string;
  /**
   * The same act reached from more than one place — "Move to the next stage" is a button on the
   * row and on the record's first face. Every one is checked; the answer names the act once.
   */
  testids?: readonly string[];
  /** What pressing it does. */
  does: string;
  /** What happens next — a card raised, a record written, a page opened. */
  then?: string;
  /** Who may press it. Omitted means either partner. */
  who?: string;
  /** The page's human act — the orange button, or the one that raises the approval card. */
  primary?: boolean;
}

export interface GuideAuto {
  /** What happens without anyone pressing anything. */
  what: string;
  /** When — "every hour", "when a Meet call ends", "on each tick". */
  when: string;
  /** The `scheduled_job.job_key` behind it, when there is one. Checked against the migrations. */
  job?: string;
}

export interface GuideLink {
  /** The nav key of the page that owns the rest. Checked against App.tsx's routes. */
  page: string;
  /** Why a reader would go there from here. */
  why: string;
}

export interface PageGuide {
  /** The nav key, as App.tsx routes it. */
  navKey: string;
  /** The page's name as the nav shows it. */
  title: string;
  /** One sentence: what this page is for. Also the purpose block at the top of the page. */
  purpose: string;
  /** Two to four headline things you can do — the purpose block's second line. */
  youCan: string[];
  /** The component files the page renders, relative to the repo root. The validator reads them. */
  sources: string[];
  /** What you see, top to bottom. */
  bands: GuideBand[];
  /** What you can do here. Every primary control on the page must be one of these. */
  acts: GuideAct[];
  /** What happens on its own. */
  auto: GuideAuto[];
  /** Where the rest lives. */
  elsewhere: GuideLink[];
  /**
   * Primary controls in `sources` that are deliberately not acts of THIS page, keyed by testid,
   * with the reason — a shared component's button that belongs to another page, or a control the
   * page renders only as a dead-end preview. Kept short and each one justified.
   */
  notActs?: Record<string, string>;
  /**
   * The page is archived: off the nav, still answering its URL, nothing new made on it. The
   * dated reason, said on the page itself so a bookmark that lands here is not confusing.
   */
  archived?: string;
}
