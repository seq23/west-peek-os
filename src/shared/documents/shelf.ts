/**
 * THE SHELF, SORTED FOR A READER — what the Documents page shows, decided here and tested here.
 *
 * Owner, 23 Oct 2026, reading on a phone: the shelf was one long pile — 21 "Brief", 25 "Review",
 * 6 "Room packet" — under internal type codes, with titles that were the first ninety characters of
 * an email (`Change westpeek.ventures: "Hey! … took a look at the spam…`), and every weekly
 * discrepancy register in it twice. This module turns the same rows into:
 *
 *   - a SUMMARY ("4 to read this week", then the newest few);
 *   - GROUPS in plain words (Playbooks & plans, Weekly reviews & sync prep, …), never type codes;
 *   - SERIES collapsed to their latest, the earlier ones one tap away ("Show 5 earlier");
 *   - identical copies filed the same day shown ONCE, the copy kept and reachable from the entry;
 *   - a READABLE TITLE when the stored one is an email snippet. The stored title is never changed
 *     here; the page shows it in full when the document is opened.
 *
 * NOTHING IS HIDDEN OR DELETED. Every row that comes in goes out: as an entry, as an earlier item
 * in a series, or as a same-day copy attached to its entry. `shelfCount` proves it in the tests.
 */

export interface ShelfDoc {
  id: string;
  title: string;
  doc_type: string;
  created_at: string;
  deck?: { version_no: number; state: string; title?: string | null } | null;
}

export type ShelfGroupKey =
  | "playbooks"
  | "reviews"
  | "rooms"
  | "deck"
  | "website"
  | "hiring"
  | "deals"
  | "notes"
  | "statements"
  | "pictures"
  | "other";

/** In the order the page shows them: what she plans with, what she reads weekly, then the rest. */
export const SHELF_GROUPS: ReadonlyArray<{ key: ShelfGroupKey; label: string; means: string }> = [
  { key: "playbooks", label: "Playbooks & plans", means: "How a programme runs, and the plans behind it." },
  { key: "reviews", label: "Weekly reviews & sync prep", means: "Each partner's prep for the Wednesday sync, and where our records and the deck disagree." },
  { key: "rooms", label: "Room & workshop packets", means: "Packets and draft event kits for Rooms and workshops." },
  { key: "deck", label: "The LP deck", means: "Every version of the fund's deck. The current one leads." },
  { key: "website", label: "Website changes", means: "Changes asked for on the firm's websites, and the plan for each." },
  { key: "hiring", label: "Hiring searches", means: "The weekly candidate searches for an open role." },
  { key: "deals", label: "Deals & companies", means: "Notes on deals and the companies behind them." },
  { key: "notes", label: "Notes & requests", means: "Requests and notes passed between the partners and the team." },
  { key: "statements", label: "LP statements & letters", means: "Statements and letters as sent to limited partners." },
  { key: "pictures", label: "Pictures", means: "Charts, screenshots and photos." },
  { key: "other", label: "Everything else", means: "Anything that fits none of the groups above." },
];

export function groupLabel(key: ShelfGroupKey): string {
  return SHELF_GROUPS.find((g) => g.key === key)!.label;
}

const WEBSITE = /^(?:Plan:\s*)?Change\s+([a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\s*,\s*[a-z0-9-]+(?:\.[a-z0-9-]+)+)*)\s*:\s*["“]?(.*)$/i;
const PREP = /^(.+?)\s+[—-]\s+prep for the Wednesday sync,\s*(\d{4}-\d{2}-\d{2})\s*$/i;
const HIRE = /^Hire search\s+(\d{4})-W(\d{1,2}):\s*(\d+)\s+candidate\(s\)\s+for\s+(.+)$/i;
const DISCREPANCY = /[—-]\s+where our (?:own )?records and the deck disagree\s*$/i;
const WEEKLY_REVIEW = /^Weekly operating review\s+[—-]\s+week of\s+(\d{4}-\d{2}-\d{2})/i;
const RELAYED = /^Porter\s*→\s*([A-Z][\w-]*)\s*:\s*(?:Tell\s+\1\s*:\s*)?(.*)$/;
const IDEA = /^([A-Z][\w-]*)\s*\((?:authenticated[^)]*)\)\s+sent an idea for (?:the\s+)?(.+?)(?:\s+and asked.*)?$/i;
const ASKED = /^([A-Z][\w-]*)\s*\((?:authenticated[^)]*)\)\s+asked:\s*(.*)$/i;
const EVENT_KIT = /^Draft event kit\s+[—-]\s+(?:Draft\s+)?(?:Proposed\s+)?Event Kit\s*[:—-]\s*(.+?)(?:\s*\(PROPOSED[^)]*\)?)?\s*$/i;

/** Greetings and fillers an email opens with, which say nothing about what was asked. */
const OPENERS = /^(?:(?:hey|hi|hello|thanks|thank you|ok|okay|yes|yea|yeah|so|quick one|one more|porter|team|all)\b[\s,!.:;—–-]*)+/i;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-10-28" → "28 Oct". The firm writes dates day-first. */
export function shortDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? m[2]}`;
}

/** Cut at a word boundary, with an ellipsis when anything was cut. */
export function clip(text: string, max = 64): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const at = cut.lastIndexOf(" ");
  return `${(at > max * 0.5 ? cut.slice(0, at) : cut).replace(/[\s,;:—–-]+$/, "")}…`;
}

function snippet(raw: string, max = 48): string {
  const words = raw.replace(/["”]+\s*$/, "").replace(/…$/, "").trim().replace(OPENERS, "").replace(/^[-–—\s]+/, "");
  const text = words.charAt(0).toUpperCase() + words.slice(1);
  return clip(text, max);
}

/**
 * A short title she can read, and whether it differs from the stored one. The stored title is the
 * record and is shown in full on open; this is only how the row is labelled.
 */
export function plainTitle(doc: Pick<ShelfDoc, "title" | "deck">): { title: string; changed: boolean } {
  const stored = (doc.deck?.title ?? doc.title).replace(/\s+/g, " ").trim();
  const make = (t: string) => ({ title: t, changed: t !== stored });

  let m = WEBSITE.exec(stored);
  if (m) {
    const sites = m[1]!.split(/\s*,\s*/).join(" and ");
    const plan = /^Plan:/i.test(stored) ? "Plan for a website change" : "Website change";
    const what = snippet(m[2]!);
    return make(what ? `${plan} on ${sites}: “${what}”` : `${plan} on ${sites}`);
  }
  m = PREP.exec(stored);
  if (m) return make(`${m[1]}'s prep for the Wednesday sync, ${shortDate(m[2]!)}`);
  m = HIRE.exec(stored);
  if (m) return make(`Hire search for ${m[4]!.trim()}, week ${Number(m[2])}: ${m[3]} candidate${m[3] === "1" ? "" : "s"}`);
  m = WEEKLY_REVIEW.exec(stored);
  if (m) return make(`Weekly operating review, week of ${shortDate(m[1]!)}`);
  m = RELAYED.exec(stored);
  if (m) return make(`Note passed to ${m[1]}: “${snippet(m[2]!)}”`);
  m = IDEA.exec(stored);
  if (m) return make(`${m[1]}'s idea for ${clip(m[2]!.replace(/\s+and\s*$/, ""), 40)}`);
  m = ASKED.exec(stored);
  if (m) return make(`${m[1]}'s request: “${snippet(m[2]!)}”`);
  m = EVENT_KIT.exec(stored);
  if (m) return make(`Draft event kit: ${clip(m[1]!, 52)}`);
  return make(clip(stored, 72));
}

export function groupOf(doc: ShelfDoc): ShelfGroupKey {
  const t = doc.deck?.title ?? doc.title;
  const type = doc.doc_type.toUpperCase();
  if (doc.deck || type === "DECK") return "deck";
  if (WEBSITE.test(t)) return "website";
  if (HIRE.test(t)) return "hiring";
  if (PREP.test(t) || DISCREPANCY.test(t) || WEEKLY_REVIEW.test(t)) return "reviews";
  if (/\bplaybook\b/i.test(t) || /^plan\b/i.test(t)) return "playbooks";
  if (type === "ROOM_PACKET" || EVENT_KIT.test(t) || /^(Room|Workshop) packet\b/i.test(t) || /\bRooms?\b/.test(t)) return "rooms";
  if (type === "REVIEW") return "reviews";
  if (type === "DILIGENCE_NOTE" || /^Deal flow\b/i.test(t)) return "deals";
  if (type === "LP_STATEMENT") return "statements";
  if (type === "IMAGE") return "pictures";
  if (type === "BRIEF") return "notes";
  return "other";
}

/**
 * Which recurring series a document belongs to, if any. A series shows only its latest on the
 * shelf, with the earlier ones one tap away.
 */
export function seriesKey(doc: ShelfDoc): string | null {
  const t = doc.title.replace(/\s+/g, " ").trim();
  let m = DISCREPANCY.exec(t);
  if (m) return `discrepancy:${t.toLowerCase()}`;
  m = PREP.exec(t);
  if (m) return `prep:${m[1]!.toLowerCase()}`;
  m = HIRE.exec(t);
  if (m) return `hire:${m[4]!.toLowerCase().trim()}`;
  if (WEEKLY_REVIEW.test(t)) return "weekly-review";
  return null;
}

/** "Where our records and the deck disagree" was filed once per partner, identically. Same title, same day = one entry. */
function copyKey(doc: ShelfDoc): string {
  return `${doc.title.replace(/\s+/g, " ").trim().toLowerCase()}|${doc.created_at.slice(0, 10)}`;
}

export interface ShelfEntry<D extends ShelfDoc = ShelfDoc> {
  doc: D;
  plain: string;
  /** The stored title, when the plain one differs — shown in full when the document is opened. */
  original: string | null;
  group: ShelfGroupKey;
  /** Identical copies filed the same day. Kept, never deleted; reachable from this entry. */
  copies: D[];
}

export interface ShelfLine<D extends ShelfDoc = ShelfDoc> {
  latest: ShelfEntry<D>;
  /** Earlier items of the same series, newest first. */
  earlier: ShelfEntry<D>[];
  series: string | null;
}

export interface ShelfGroup<D extends ShelfDoc = ShelfDoc> {
  key: ShelfGroupKey;
  label: string;
  means: string;
  lines: ShelfLine<D>[];
  /** Entries in the group, counting each series' earlier items. */
  count: number;
}

export interface Shelf<D extends ShelfDoc = ShelfDoc> {
  thisWeek: number;
  newest: ShelfEntry<D>[];
  groups: ShelfGroup<D>[];
  /** Every group with something in it, for the filter pull-down — counted before any search. */
  available: Array<{ key: ShelfGroupKey; label: string; count: number }>;
}

const deckRank = (d: ShelfDoc): number => (d.deck?.state === "CURRENT" ? 0 : d.deck?.state === "PROPOSED" ? 1 : 2);

function entryMatches(e: ShelfEntry, q: string): boolean {
  if (!q) return true;
  const hay = [e.plain, e.doc.title, e.doc.deck?.title ?? "", groupLabel(e.group), ...e.copies.map((c) => c.title)].join(" ").toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

/**
 * Sort a list of documents into the shelf the page shows.
 *
 * `query` narrows to entries whose plain or stored title contains every word; `group` narrows to
 * one group ("all" for every group). Counts in the summary and the pull-down ignore both, so the
 * numbers do not jump while she types.
 */
export function buildShelf<D extends ShelfDoc>(docs: readonly D[], opts: { now?: Date; query?: string; group?: ShelfGroupKey | "all" } = {}): Shelf<D> {
  const now = opts.now ?? new Date();
  const sorted = [...docs].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : a.id < b.id ? -1 : 1));

  // 1 · Identical copies filed the same day become one entry.
  const byCopy = new Map<string, ShelfEntry<D>>();
  const entries: ShelfEntry<D>[] = [];
  for (const d of sorted) {
    const key = copyKey(d);
    const existing = d.deck ? undefined : byCopy.get(key);
    if (existing) {
      existing.copies.push(d);
      continue;
    }
    const p = plainTitle(d);
    const stored = (d.deck?.title ?? d.title).replace(/\s+/g, " ").trim();
    const e: ShelfEntry<D> = { doc: d, plain: p.title, original: p.changed ? stored : null, group: groupOf(d), copies: [] };
    byCopy.set(key, e);
    entries.push(e);
  }

  // 2 · The summary reads the whole shelf.
  const weekAgo = now.getTime() - 7 * 24 * 3600 * 1000;
  const thisWeek = entries.filter((e) => Date.parse(e.doc.created_at) >= weekAgo).length;
  // The newest three, one per series: last week's hire search is not news beside this week's.
  const seen = new Set<string>();
  const newest: ShelfEntry<D>[] = [];
  for (const e of entries) {
    const s = seriesKey(e.doc);
    if (s && seen.has(s)) continue;
    if (s) seen.add(s);
    newest.push(e);
    if (newest.length === 3) break;
  }

  const available = SHELF_GROUPS.map((g) => ({ key: g.key, label: g.label, count: entries.filter((e) => e.group === g.key).length })).filter((g) => g.count > 0);

  // 3 · Narrow, then collapse each series to its latest.
  const q = (opts.query ?? "").trim();
  const want = opts.group ?? "all";
  const shown = entries.filter((e) => (want === "all" || e.group === want) && entryMatches(e, q));
  const groups: ShelfGroup<D>[] = [];
  for (const g of SHELF_GROUPS) {
    const inGroup = shown.filter((e) => e.group === g.key);
    if (inGroup.length === 0) continue;
    const lines: ShelfLine<D>[] = [];
    const bySeries = new Map<string, ShelfLine<D>>();
    for (const e of inGroup) {
      const s = seriesKey(e.doc);
      if (s && bySeries.has(s)) {
        bySeries.get(s)!.earlier.push(e);
        continue;
      }
      const line: ShelfLine<D> = { latest: e, earlier: [], series: s };
      if (s) bySeries.set(s, line);
      lines.push(line);
    }
    if (g.key === "deck") {
      lines.sort((a, b) => deckRank(a.latest.doc) - deckRank(b.latest.doc) || (b.latest.doc.deck?.version_no ?? 0) - (a.latest.doc.deck?.version_no ?? 0));
    }
    groups.push({ ...g, lines, count: inGroup.length });
  }
  return { thisWeek, newest, groups, available };
}

/** Every document the shelf accounts for — entries, earlier items and same-day copies. */
export function shelfCount(shelf: Shelf): number {
  let n = 0;
  for (const g of shelf.groups) for (const l of g.lines) for (const e of [l.latest, ...l.earlier]) n += 1 + e.copies.length;
  return n;
}

const EXT: Array<[RegExp, string]> = [
  [/markdown/, "md"],
  [/pdf/, "pdf"],
  [/html/, "html"],
  [/csv/, "csv"],
  [/json/, "json"],
  [/png/, "png"],
  [/jpe?g/, "jpg"],
  [/presentationml/, "pptx"],
  [/wordprocessingml/, "docx"],
  [/text\/plain/, "txt"],
];

/** A file name she can recognise in Downloads: the readable title plus the right extension. */
export function downloadName(title: string, contentType: string): string {
  const base = title.replace(/[\\/:*?"<>|“”]+/g, "").replace(/\s+/g, " ").trim().slice(0, 100) || "document";
  const ext = EXT.find(([re]) => re.test(contentType.toLowerCase()))?.[1];
  return ext && !base.toLowerCase().endsWith(`.${ext}`) ? `${base}.${ext}` : base;
}

