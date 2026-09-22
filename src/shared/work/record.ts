import { RECURRING_CARD_KINDS } from "./recurring";
import type { OriginKind } from "./origin";

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
 *
 * ── A ONE-OFF ASSIGNMENT NEVER COLLAPSES (Addendum 4, 22 Sep 2026) ───────────────────────────────
 *
 * Her decision: "identical runs collapsed" stays right for noisy recurring duties (the daily
 * brief, the sweep) — but "a one-off assignment is never identical to anything else and should
 * never collapse", even when it happens to share a month, title, owner and state with another. The
 * fifth key column, `collapse_scope`, is how the group key still names EXACTLY
 * `RECORD_GROUP_COLUMNS` (the validator's own invariant) while making that true: for a recurring
 * kind (`isRecurringKind`, `@shared/work/recurring` — the same axis Machinery's two buckets read)
 * its SQL is a constant, so identical runs of the same recurring duty still fold into one row; for
 * every one-off kind — and the plain, hand-made `kind = NULL` card — its SQL is the card's own id,
 * which cannot equal any other card's id, so a one-off row can never collapse into a sibling no
 * matter how alike the other four columns look.
 */

/** The columns that, taken together, mean "this is the same piece of work, run again". */
export const RECORD_GROUP_COLUMNS = ["month", "title", "owner_id", "state", "collapse_scope"] as const;

/** `'KIND_A','KIND_B',…` — recurring kinds, inlined as SQL literals from our own registry, never
 *  user input. Built once, at module load, so `RECORD_GROUP_SQL.collapse_scope` stays a plain
 *  string like every other entry rather than needing its own binding mechanism. */
const RECURRING_KIND_LIST_SQL = RECURRING_CARD_KINDS.map((k) => `'${k}'`).join(", ") || "''";

/** How each group column is spelled in the record query's SELECT list. */
export const RECORD_GROUP_SQL: Readonly<Record<(typeof RECORD_GROUP_COLUMNS)[number], string>> = {
  month: "substr(wc.created_at, 1, 7)",
  title: "wc.title",
  owner_id: "wc.owner_id",
  state: "wc.state",
  collapse_scope: `CASE WHEN wc.kind IN (${RECURRING_KIND_LIST_SQL}) THEN '' ELSE wc.id END`,
};

/**
 * WHAT SHE TYPED, TURNED INTO LIKE TERMS THE DATABASE WILL ACTUALLY ACCEPT.
 *
 * MEASURED, NOT ASSUMED. D1 refuses a LIKE pattern of 50 characters or more — `SQLITE_ERROR: LIKE
 * or GLOB pattern too complex`. Probed against the local binding on 18 Sep 2026: a 40-character
 * term (42 with its two wildcards) answers, 48 does not. A single `%…%` over the whole query
 * therefore fails on any search longer than a short phrase, and it fails as a 500 — so the
 * behaviour she would have seen is the record going blank on the longest, most specific searches,
 * which are the ones she makes when she actually remembers something.
 *
 * TOKENISING IS THE FIX AND IT IS ALSO THE BETTER SEARCH. Each word becomes its own term and the
 * terms are ANDed, so "room packet black lawyers" matches a title and a result line between them
 * and does not care what order she typed them in. It cannot exceed the limit by construction:
 * every term is capped well under it, and the number of terms is capped too, because ten ANDed
 * LIKEs over the firm's whole history is a scan nobody asked for.
 */
export const LIKE_TERM_MAX = 32;
export const LIKE_TERMS_MAX = 6;

export function searchTerms(q: string): string[] {
  return q
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => t.slice(0, LIKE_TERM_MAX))
    .slice(0, LIKE_TERMS_MAX);
}

/**
 * Which finished states the record can be narrowed to. `ALL` is both DONE and CANCELLED — and,
 * since Addendum 10 (22 Sep 2026), NEVER `NO_ACTION_NEEDED`: a card the intake classifier caught as
 * banter is excluded from "everything the firm has finished" by default, the same way it is
 * excluded from DONE and CANCELLED individually. `STOWED` is its own named filter rather than a
 * fourth thing `ALL` quietly includes — her instruction was an actual reachable place these live,
 * not just an invisible exclusion.
 */
export const RECORD_STATES = ["ALL", "DONE", "CANCELLED", "STOWED"] as const;
export type RecordState = (typeof RECORD_STATES)[number];

/**
 * ORIGIN, AS A FILTER (Addendum 4, 22 Sep 2026): "by origin (assignment vs scheduled vs started by
 * her)". Reuses `OriginKind` from `@shared/work/origin` — built by Wave C, not reinvented here —
 * minus `YOU`. The Record is read later, by either partner, with no fixed "viewer": `originOf()`
 * only ever returns `YOU` when it is told who is looking, and a filter option whose meaning
 * changed depending on who was browsing would be the wrong kind of control for a shared record. A
 * card she made herself still answers `PARTNER` here, exactly as it does when Scooter looks at it.
 */
/**
 * KIND FILTER SENTINEL for "no kind" (the plain, hand-made card). A real, non-empty string rather
 * than an empty one, so the client and the server agree it means "filtering", never "no filter
 * sent" — the ambiguity an empty-string-vs-absent convention would otherwise carry.
 */
export const NO_KIND_FILTER_VALUE = "__NO_KIND__";

export const RECORD_ORIGIN_KINDS: readonly Exclude<OriginKind, "YOU">[] = [
  "EMAIL",
  "PARTNER",
  "MEETING",
  "CAPTURE",
  "ANOTHER_CARD",
  "SYSTEM",
];
export type RecordOriginKind = (typeof RECORD_ORIGIN_KINDS)[number];

/** One short phrase per origin filter option, for the dropdown. */
export function recordOriginLabel(kind: RecordOriginKind): string {
  switch (kind) {
    case "EMAIL":
      return "An email";
    case "PARTNER":
      return "A partner, in the OS";
    case "MEETING":
      return "A meeting";
    case "CAPTURE":
      return "Something captured";
    case "ANOTHER_CARD":
      return "Handed off from another card";
    case "SYSTEM":
    default:
      return "The system or the sweep";
  }
}

export interface RecordRow {
  /** The most recent card in the group — the one "Open" and "Reopen" act on. */
  id: string;
  title: string;
  state: "DONE" | "CANCELLED";
  /** `NO_ACTION_NEEDED` when this row is a banter card the classifier auto-resolved (Addendum 10). */
  auto_resolution: "NO_ACTION_NEEDED" | null;
  owner_id: string | null;
  owner_name: string | null;
  /** `YYYY-MM`, the spine this row hangs under. */
  month: string;
  /** When the most recent run in this group finished. */
  at: string;
  /** How many identical runs collapsed into this row. Always 1 for a one-off card (Addendum 4) —
   *  only a recurring kind can show more, and only when two runs are otherwise identical. */
  runs: number;
  /** The last "• …" line the employee wrote — the verdict, not the working. */
  result: string | null;
  model_access: string;
  audience: string;
  kind: string | null;
  /** Computed server-side with `originOf()`/`originBadgeText()` — never re-derived on the client. */
  origin_kind: OriginKind;
  origin_label: string;
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
  /** Every kind the record covers, with how many cards — including `null` (the plain card) as "". */
  kinds: Array<{ kind: string; label: string; cards: number }>;
  /** Every origin the record covers, with how many cards. */
  origins: Array<{ origin: RecordOriginKind; label: string; cards: number }>;
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
export function isFiltered(query: {
  q?: string;
  who?: string;
  month?: string;
  state?: RecordState;
  kind?: string;
  origin?: string;
  from?: string;
  to?: string;
}): boolean {
  return Boolean(
    (query.q ?? "").trim() ||
      (query.who ?? "") ||
      (query.month ?? "") ||
      (query.state && query.state !== "ALL") ||
      (query.kind ?? "") ||
      (query.origin ?? "") ||
      (query.from ?? "") ||
      (query.to ?? ""),
  );
}
