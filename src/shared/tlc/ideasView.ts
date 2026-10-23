import { topicKey } from "./learningClub";

/**
 * THE IDEAS CARD ON EVENTS & ROOMS (owner approved the v8 mock-up, 23 Oct 2026). Pure, so it is
 * tested without a browser (tests/roomsPages.test.ts).
 *
 *  - ONE ROW PER IDEA. "The Record Room" and "The Record Room (November 2026 Room)" are one idea filed
 *    twice; so are "Sewing, matcha, day trading" and the same words with "(examples of learning-club
 *    topics)" after them. A trailing parenthesis does not make a new idea. The earlier row is shown;
 *    the others are kept on the record and named under it. Nothing is deleted.
 *  - LIVE IDEAS are the ones still in play (picked, alternatives, later). SET ASIDE is dropped or merged.
 *  - THE PREVIEW is what the card shows before "Show all": the picked ones, by month, then the newest.
 */

export type IdeaStatus = "LATER" | "PICKED" | "ALTERNATIVE" | "DROPPED" | "MERGED";

export interface IdeaLike {
  id: string;
  topic: string;
  status: IdeaStatus;
  status_month: string | null;
  suggested_at: string;
  suggested_by: string;
  origin_label?: string;
  note?: string | null;
  notes?: ReadonlyArray<{ body: string; author: string; created_at: string }>;
}

export interface IdeaEntry<I extends IdeaLike> {
  idea: I;
  /** Other rows of the same idea, kept on the record. */
  alsoListed: I[];
}

export type IdeaFilter = "live" | "picked" | "alternatives" | "later" | "set-aside" | "everything";

export const IDEA_FILTERS: ReadonlyArray<{ key: IdeaFilter; label: string }> = [
  { key: "live", label: "Live ideas" },
  { key: "picked", label: "Picked for a club" },
  { key: "alternatives", label: "Alternatives" },
  { key: "later", label: "On the list for later" },
  { key: "set-aside", label: "Set aside" },
  { key: "everything", label: "Everything" },
];

export const isSetAside = (i: Pick<IdeaLike, "status">): boolean => i.status === "DROPPED" || i.status === "MERGED";

/** The idea's name for matching: its key, with a trailing "(…)" left off. */
export function ideaKey(topic: string): string {
  return topicKey(topic.replace(/\s*\([^)]*\)\s*$/, ""));
}

const rank = (i: IdeaLike): number => (i.status === "PICKED" ? 0 : i.status === "ALTERNATIVE" ? 1 : i.status === "LATER" ? 2 : 3);

/** One entry per idea. The row shown is the live one if any is live, else the earliest. */
export function dedupeIdeas<I extends IdeaLike>(ideas: readonly I[]): IdeaEntry<I>[] {
  const groups = new Map<string, I[]>();
  for (const i of ideas) {
    const k = ideaKey(i.topic) || i.id;
    groups.set(k, [...(groups.get(k) ?? []), i]);
  }
  const out: IdeaEntry<I>[] = [];
  for (const rows of groups.values()) {
    const sorted = [...rows].sort((a, b) => rank(a) - rank(b) || (a.suggested_at < b.suggested_at ? -1 : a.suggested_at > b.suggested_at ? 1 : a.id < b.id ? -1 : 1));
    out.push({ idea: sorted[0]!, alsoListed: sorted.slice(1) });
  }
  return out;
}

/** Picked first (by month), then alternatives, then later; newest first inside each. */
export function orderIdeas<I extends IdeaLike>(entries: readonly IdeaEntry<I>[]): IdeaEntry<I>[] {
  return [...entries].sort((a, b) => {
    const r = rank(a.idea) - rank(b.idea);
    if (r) return r;
    if (a.idea.status === "PICKED") return (a.idea.status_month ?? "") < (b.idea.status_month ?? "") ? -1 : 1;
    return a.idea.suggested_at > b.idea.suggested_at ? -1 : a.idea.suggested_at < b.idea.suggested_at ? 1 : 0;
  });
}

export function matchesFilter(i: IdeaLike, f: IdeaFilter): boolean {
  switch (f) {
    case "live": return !isSetAside(i);
    case "picked": return i.status === "PICKED";
    case "alternatives": return i.status === "ALTERNATIVE";
    case "later": return i.status === "LATER";
    case "set-aside": return isSetAside(i);
    case "everything": return true;
  }
}

export function matchesSearch(e: IdeaEntry<IdeaLike>, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = [e.idea.topic, e.idea.note ?? "", e.idea.suggested_by, ...(e.idea.notes ?? []).map((n) => n.body), ...e.alsoListed.map((x) => x.topic)].join(" ").toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** What the card shows before "Show all": every picked idea, then the newest few of the rest. */
export function previewIdeas<I extends IdeaLike>(ordered: readonly IdeaEntry<I>[], newest = 3): IdeaEntry<I>[] {
  const picked = ordered.filter((e) => e.idea.status === "PICKED");
  const rest = ordered
    .filter((e) => e.idea.status !== "PICKED" && !isSetAside(e.idea))
    .sort((a, b) => (a.idea.suggested_at > b.idea.suggested_at ? -1 : a.idea.suggested_at < b.idea.suggested_at ? 1 : 0))
    .slice(0, newest);
  return [...picked, ...rest];
}

/** The club month this idea is the BACKUP for, from the clubs' stored backups. "Money Reset" is 'Trading & Investing ("Money Reset")'. */
export function backupMonthFor(topic: string, backups: ReadonlyArray<{ month: string; topic: string }>): string | null {
  const k = topicKey(topic);
  for (const b of backups) {
    const bk = topicKey(b.topic);
    if (bk && (k === bk || k.includes(bk) || bk.includes(k))) return b.month;
  }
  return null;
}
