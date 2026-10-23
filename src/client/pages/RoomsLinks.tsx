import { useEffect, useRef, type ReactNode } from "react";

/**
 * EVENTS & ROOMS IS FOUR PAGES (owner approved the v8 mock-up, 23 Oct 2026): Events & Rooms, The
 * Learning Club, Room sponsors and the Research library. Every one of them carries the same slim row
 * of text links at the top — never big cards — and a "← Back". The three below Events & Rooms are
 * addresses of their own (`#/learning-club`, `#/room-sponsors`, `#/research-library`), titled in
 * lib/pageTitles.ts and filed under Events & Rooms.
 */

export type RoomsPageKey = "rooms" | "learning-club" | "room-sponsors" | "research-library";

export const ROOMS_SUBPAGES: ReadonlyArray<{ key: Exclude<RoomsPageKey, "rooms">; label: string }> = [
  { key: "learning-club", label: "The Learning Club" },
  { key: "room-sponsors", label: "Room sponsors" },
  { key: "research-library", label: "Research library" },
];

function goBack(): void {
  if (window.history.length > 1) window.history.back();
  else window.location.hash = "#/home";
}

export function RoomsLinks({ current }: { current: RoomsPageKey }): JSX.Element {
  return (
    <nav className="rooms-links" aria-label="Events & Rooms pages" data-testid="rooms-links">
      {current === "rooms" ? (
        <button type="button" className="link-button rooms-back" data-testid="rooms-back" onClick={goBack}>
          ← Back
        </button>
      ) : (
        <a className="rooms-back" href="#/rooms" data-testid="rooms-back">
          ← Back to Events &amp; Rooms
        </a>
      )}
      <span className="rooms-links-row">
        {ROOMS_SUBPAGES.map((p) =>
          p.key === current ? (
            <strong key={p.key} aria-current="page" data-testid={`rooms-link-${p.key}`}>
              {p.label}
            </strong>
          ) : (
            <a key={p.key} href={`#/${p.key}`} data-testid={`rooms-link-${p.key}`}>
              {p.label} →
            </a>
          ),
        )}
      </span>
    </nav>
  );
}

/**
 * One labelled folded row: the title, the count, and what to tap. Open or shut, the summary says
 * which ("Open ▾" / "Close ▴"); the count is visible while it is shut.
 */
export function RoomsFold(props: { title: string; count: ReactNode; testId: string; openWhen?: boolean; children: ReactNode }): JSX.Element {
  // Opens by itself when something inside needs her (a Workshop waiting); never shuts one she opened.
  const ref = useRef<HTMLDetailsElement | null>(null);
  useEffect(() => {
    if (props.openWhen && ref.current) ref.current.open = true;
  }, [props.openWhen]);
  return (
    <details className="rooms-fold" data-testid={props.testId} ref={ref}>
      <summary>
        <h3>{props.title}</h3>
        <span className="rooms-fold-count">
          {props.count} · <span className="fold-closed">Open ▾</span>
          <span className="fold-open">Close ▴</span>
        </span>
      </summary>
      <div className="rooms-fold-body">{props.children}</div>
    </details>
  );
}

/** The "How this works — <page> ▾" lid at the bottom of each page. */
export function HowThisWorksFold(props: { page: string; testId: string; children: ReactNode }): JSX.Element {
  return (
    <details className="rooms-how" data-testid={props.testId}>
      <summary>How this works — {props.page} ▾</summary>
      <div className="rooms-fold-body">{props.children}</div>
    </details>
  );
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LONG_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "2026-10-23…" → "23 Oct 2026"; with `weekday`, "Fri 23 Oct 2026". The firm writes dates day-first. Never an ISO string on screen. */
export function dayWords(iso: string | null | undefined, opts: { weekday?: boolean; year?: boolean } = {}): string {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const wd = DAYS[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()];
  const year = opts.year === false ? "" : ` ${y}`;
  return `${opts.weekday ? `${wd} ` : ""}${d} ${MONTHS[mo - 1] ?? m[2]}${year}`;
}

/** "2027-03" → "March 2027"; `short` → "Mar 2027". */
export function monthWords(yyyyMm: string | null | undefined, short = false): string {
  if (!yyyyMm) return "";
  const n = Number(yyyyMm.slice(5, 7));
  const name = (short ? MONTHS : LONG_MONTHS)[n - 1];
  return name ? `${name} ${yyyyMm.slice(0, 4)}` : yyyyMm;
}
