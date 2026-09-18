/**
 * THE RECORD — what the firm has finished, at day-200 volume.
 *
 * WHAT WAS WRONG, measured on the live page on 18 Sep 2026 with 531 finished cards in the
 * database. The Work page rendered `finished.slice(0, 50)` out of a payload the server had already
 * capped at `LIMIT 500`, under a `<details open>` with no search, no filter and no grouping. So:
 *
 *   · 481 of 531 finished cards were unreachable from the page, silently. Not slow to find —
 *     ABSENT, with nothing on screen saying so.
 *   · the fifty that did render ran to 3,300px of undifferentiated list on a laptop, inside the
 *     same scroll as the two things actually waiting on her.
 *   · three identical runs of one job rendered as three separate rows, which reads as three
 *     achievements rather than three attempts at one thing.
 *
 * The owner's standard for this page is "can she find last month's Room packet in ten seconds on
 * day 200". A client-side slice of a server-side cap cannot answer that at any volume, and the
 * failure is invisible — which is why this is a retrieval problem with a server behind it, not a
 * layout problem with a filter bolted on.
 *
 * SEARCH IS THE PRIMARY AXIS, MONTH IS THE SPINE. The owner suggested filtering by month. Month is
 * the right way to ORGANISE the record and the wrong way to SEARCH it: you remember what a thing
 * was, not which month it landed in. So the free-text box is the first control and the default
 * view, and the month grouping is what the results arrive inside — plus a month filter for the
 * times she does remember.
 *
 * ── THE COLLAPSE KEY ──────────────────────────────────────────────────────────────────────────
 *
 * `RECORD_GROUP_COLUMNS` is the definition of "the same thing, done again", and it is DECLARED
 * HERE rather than written once into a SQL string, because the SQL is where it would drift. The
 * validator `the-record-scales.mjs` reads this array and requires the GROUP BY in the record query
 * to name exactly these columns — a specification no code reads is a wish, so this one is read.
 *
 * WHY THE MONTH IS PART OF THE KEY. A Room packet built in March and another built in September
 * are two pieces of work and must stay two rows; three runs of the September packet in one week
 * are one piece of work attempted three times. Collapsing across the whole record would hide real
 * output; not collapsing at all is what the page does today.
 */

/** The columns that, taken together, mean "this is the same piece of work, run again". */
export const RECORD_GROUP_COLUMNS = ["month", "title", "owner_id", "state"] as const;

/** How each group column is spelled in the record query's SELECT list. */
export const RECORD_GROUP_SQL: Readonly<Record<(typeof RECORD_GROUP_COLUMNS)[number], string>> = {
  month: "substr(wc.created_at, 1, 7)",
  title: "wc.title",
  owner_id: "wc.owner_id",
  state: "wc.state",
};

/** Which finished states the record can be narrowed to. `ALL` is both, and is the default. */
export const RECORD_STATES = ["ALL", "DONE", "CANCELLED"] as const;
export type RecordState = (typeof RECORD_STATES)[number];

export interface RecordRow {
  /** The most recent card in the group — the one "Open" and "Reopen" act on. */
  id: string;
  title: string;
  state: "DONE" | "CANCELLED";
  owner_id: string | null;
  owner_name: string | null;
  /** `YYYY-MM`, the spine this row hangs under. */
  month: string;
  /** When the most recent run in this group finished. */
  at: string;
  /** How many identical runs collapsed into this row. 1 means nothing was collapsed. */
  runs: number;
  /** The last "• …" line the employee wrote — the verdict, not the working. */
  result: string | null;
  model_access: string;
  audience: string;
  kind: string | null;
}

export interface RecordPage {
  rows: RecordRow[];
  /** Everything that matched, before paging: finished cards, and rows after collapsing. */
  matched: { cards: number; rows: number };
  /** Everything in the record, ignoring the current filter. The denominator she is scanning. */
  total: { cards: number; rows: number };
  /** Opaque offset for the next page, or null when this is the last one. */
  next_cursor: string | null;
  /** Every month the record covers, newest first, with how many cards landed in it. */
  months: Array<{ month: string; label: string; cards: number }>;
  /** Everyone who has finished anything, with how much. */
  people: Array<{ owner_id: string; name: string; cards: number }>;
  /** The oldest card in the record — "everything since …". */
  since: string | null;
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * `2026-09` → `September 2026`.
 *
 * Built from the string rather than from `new Date()`, because `new Date("2026-09")` is parsed as
 * UTC midnight and then rendered in the reader's zone, which silently relabels every month boundary
 * for anyone west of Greenwich — the firm is in Chicago.
 */
export function monthLabel(month: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return month;
  const index = Number(m[2]) - 1;
  return index >= 0 && index < 12 ? `${MONTH_NAMES[index]} ${m[1]}` : month;
}

/** `2026-09-16T14:02:00Z` → `2026-09`. The spine key, derived the same way the SQL derives it. */
export function monthOf(isoAt: string): string {
  return isoAt.slice(0, 7);
}

/**
 * Rows split into their month bands, newest month first, rows newest first inside each.
 *
 * The server already returns them in that order; this exists so the client renders bands without
 * re-sorting, and so the ordering contract has one implementation a test can hold.
 */
export function bandByMonth(rows: readonly RecordRow[]): Array<{ month: string; label: string; rows: RecordRow[] }> {
  const bands: Array<{ month: string; label: string; rows: RecordRow[] }> = [];
  for (const row of rows) {
    const last = bands[bands.length - 1];
    if (last && last.month === row.month) last.rows.push(row);
    else bands.push({ month: row.month, label: monthLabel(row.month), rows: [row] });
  }
  return bands;
}

/**
 * The sentence above the results — what she is looking at, in numbers she can check.
 *
 * SAID EVEN WHEN NOTHING IS FILTERED, because the count is the thing the old page lied about: it
 * printed "Finished 496" over fifty rows. A denominator that does not match what is on screen is
 * worse than no denominator, so this states both, always.
 */
export function recordSummary(page: Pick<RecordPage, "matched" | "total" | "rows">, filtered: boolean): string {
  const { matched, total, rows } = page;
  const collapsed = matched.cards - matched.rows;
  const parts: string[] = [];
  parts.push(
    filtered
      ? `${matched.cards.toLocaleString()} of ${total.cards.toLocaleString()} finished match`
      : `${total.cards.toLocaleString()} finished`,
  );
  if (collapsed > 0) parts.push(`${matched.rows.toLocaleString()} rows after identical runs are collapsed`);
  parts.push(
    rows.length >= matched.rows
      ? `showing all ${rows.length.toLocaleString()}`
      : `showing the most recent ${rows.length.toLocaleString()}`,
  );
  return parts.join(" · ");
}

/** True when any control has narrowed the record — decides which sentence `recordSummary` says. */
export function isFiltered(query: { q?: string; who?: string; month?: string; state?: RecordState }): boolean {
  return Boolean(
    (query.q ?? "").trim() ||
      (query.who ?? "") ||
      (query.month ?? "") ||
      (query.state && query.state !== "ALL"),
  );
}
