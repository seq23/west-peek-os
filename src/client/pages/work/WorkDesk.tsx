import { useMemo, useState } from "react";
import { shortDate } from "../../lib/dates";
import { formedStamp } from "@shared/work/formedStamp";
import type { MeResponse } from "../../lib/api";
import { CARD_SOURCES } from "@shared/work/workCards";
import { originOf, type OriginKind } from "@shared/work/origin";
import { cardKind } from "@shared/work/cardKinds";
import { firstSentence, liveStatus, type LiveStatus } from "@shared/work/liveStatus";
import { SITE_STAGES, siteStage } from "@shared/work/siteChange";
import { portraitFor } from "../../lib/employeePortraits";
import { CardExpanded } from "./CardExpanded";
import type { Assignable, WorkCardRow } from "./types";

/**
 * THE DESK — what needs you, and what is being worked (23 Sep 2026, the work-card redesign).
 *
 * Her words, approving the canvas: "it's too much for a work home landing page. it should be truly
 * collapsed with only the title and in progress and the necessary things showing then a big
 * chevron or some obvious expansion button that has everything and i shouldnt have to click again
 * to see everything."
 *
 * So every card at rest is ONE ROW: the face and name of who has it, a plain title, one status pill
 * with one plain line, the Plan → Build → Preview → Live track for a website job, and a big
 * "Show everything" button. Nothing else — no origin badge, no model label, no switch, no next
 * action. One press opens `CardExpanded` directly under the row, and it holds everything.
 *
 * The status on the row is `liveStatus` (shared/work/liveStatus.ts). The sections, the header's
 * sentence and the tab dot are all counted from those same statuses, so the page cannot say "one
 * thing is stopped" over a section that shows nothing stopped.
 */

export interface MachineryHealth {
  total: number;
  green: number;
  trouble: number;
  never: number;
}

export interface DeckWaiting {
  id: string;
  version_no: number;
  title: string;
  state: string;
  created_by: string;
  created_at: string;
  document_id: string | null;
  change_summary: string | null;
}

export interface DeskEntry {
  card: WorkCardRow;
  status: LiveStatus;
}

/**
 * THE TWO SECTIONS, FROM ONE READER. Exported as a pure function because the masthead above the
 * tabs counts what it returns — one rule, read twice, never two lists each keeping their own idea
 * of what "needs you" means.
 */
export function deskSections(
  live: WorkCardRow[],
  meId: string,
  now: Date = new Date(),
  /** When she last looked at the desk (0225): what arrived since sorts first in "Needs you". */
  seenAt: string | null = null,
): { needs: DeskEntry[]; worked: DeskEntry[] } {
  const needs: DeskEntry[] = [];
  const worked: DeskEntry[] = [];
  for (const card of live) {
    const status = liveStatus(card, meId, now);
    if (status.section === "needs") needs.push({ card, status });
    else if (status.section === "worked") worked.push({ card, status });
  }
  // What is moving this minute first, then what is waiting, then what is queued.
  // A card stopped on the other partner sits with the cards they carry, not in her "Needs you".
  const rank: Record<string, number> = { WORKING_NOW: 0, WITH_PARTNER: 1, NEEDS_PARTNER: 1, WAITING: 2, QUEUED: 3 };
  worked.sort((a, b) => (rank[a.status.kind] ?? 9) - (rank[b.status.kind] ?? 9));
  if (seenAt) {
    const seen = Date.parse(seenAt);
    const fresh = (e: DeskEntry) => (Date.parse(e.card.created_at) > seen ? 0 : 1);
    needs.sort((a, b) => fresh(a) - fresh(b));
  }
  return { needs, worked };
}

/**
 * Who is carrying a card, with their face. Falls back to initials, and says "Nobody" rather than
 * nothing — an unowned card is a real state and the one most worth spotting.
 */
export function OwnerChip({ name }: { name: string | null }): JSX.Element {
  if (!name) return <span className="owner-chip owner-chip-none">Nobody owns this</span>;
  const src = portraitFor(name);
  return (
    <span className="owner-chip">
      {src ? (
        <img className="owner-face" src={src} alt="" loading="lazy" />
      ) : (
        <span className="owner-face owner-face-initial" aria-hidden="true">{name.slice(0, 1)}</span>
      )}
      {name}
    </span>
  );
}

/** The face and name on the left of a row. */
function RowOwner({ name, partners = [] }: { name: string | null; partners?: Array<{ first_name: string; role: string }> }): JSX.Element {
  const src = name ? portraitFor(name) : null;
  return (
    <span className="wc-owner">
      {/* THE TWO PARTNERS WHO HOLD IT (0241), primary first — beside who is doing the work. */}
      {partners.length > 0 && (
        <span className="wc-partner-faces" aria-label={partners.map((p) => `${p.role}: ${p.first_name}`).join(", ")}>
          {partners.map((p) => (
            <span key={p.role} className="wc-partner-face" title={`${p.role}: ${p.first_name}`} aria-hidden="true">
              {p.first_name.slice(0, 1)}
            </span>
          ))}
        </span>
      )}
      {src ? (
        <img className="wc-avatar" src={src} alt="" loading="lazy" />
      ) : (
        <span className="wc-avatar wc-avatar-initials" aria-hidden="true">
          {(name ?? "?").slice(0, 2)}
        </span>
      )}
      <span className="wc-owner-name">{name ?? "Nobody"}</span>
    </span>
  );
}

/** The big, labelled expansion button. aria-expanded is the state; the label says what it does. */
function ShowEverything({ id, open, onToggle, "data-testid": testid }: { id: string; open: boolean; onToggle: () => void; "data-testid": string }): JSX.Element {
  return (
    <button type="button" className={open ? "wc-toggle is-open" : "wc-toggle"} aria-expanded={open} aria-controls={`work-card-expanded-${id}`} data-testid={testid} onClick={onToggle}>
      {open ? "Hide" : "Show everything"}
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={open ? "M6 15l6-6 6 6" : "M6 9l6 6 6-6"} />
      </svg>
    </button>
  );
}

/** Plan → Build → Preview → Live, on the row. */
function SiteTrack({ card }: { card: WorkCardRow }): JSX.Element {
  const stage = siteStage({
    phase: card.site_phase,
    preview_url: card.site_preview_url,
    land_approved_at: card.site_land_approved_at,
    merge_sha: card.site_merge_sha,
    preview_only: card.site_preview_only,
    publish_ready: card.site_publish_ready,
  });
  return (
    <ol className="wc-track" aria-label="Stage" data-testid={`work-card-track-${card.id}`}>
      {SITE_STAGES.map((s, i) => {
        const state = stage.finished || i < stage.index ? "done" : i === stage.index ? "now" : "next";
        return (
          <li key={s.key} data-state={state} aria-current={state === "now" ? "step" : undefined}>
            {s.label}
          </li>
        );
      })}
    </ol>
  );
}

export function StatusPill({ status, testid }: { status: LiveStatus; testid?: string }): JSX.Element {
  return (
    <span className={`wc-pill wc-pill-${status.kind.toLowerCase()}`} data-testid={testid} data-kind={status.kind}>
      {status.live && <span className="wc-live-dot" aria-hidden="true" />}
      {status.pill}
    </span>
  );
}

export function WorkDesk({
  me,
  sections,
  live,
  decksWaiting,
  assignable,
  answerIsClear,
  adding,
  busy,
  setBusy,
  setMessage,
  reload,
  onNavigate,
  onMove,
  onGoto,
  machineryHealth,
  loaded,
}: {
  /**
   * Whether the board has answered. Until it has, the desk says it is reading — never "Nothing is
   * open", which on a slow load was a false empty state, and never the footer, which specs (and
   * people) take as "the desk has finished drawing".
   */
  loaded: boolean;
  me: MeResponse;
  sections: { needs: DeskEntry[]; worked: DeskEntry[] };
  live: WorkCardRow[];
  decksWaiting: DeckWaiting[];
  assignable: Assignable | null;
  /** Whether the masthead answer is "nothing needs you" — the designed empty state below. */
  answerIsClear: boolean;
  adding: boolean;
  busy: boolean;
  setBusy: (next: boolean) => void;
  setMessage: (next: string | null) => void;
  reload: () => void;
  onNavigate: (k: string) => void;
  /** Moving a card belongs to the shell, because the record view moves cards through it too. */
  onMove: (id: string, state: string) => void;
  onGoto: (view: "record" | "machinery") => void;
  machineryHealth: MachineryHealth;
}): JSX.Element {
  /**
   * WHICH CARDS ARE OPEN, by id. Collapsed is the default and that is the whole point. Opening a
   * card is a reading position, not a preference, so it is not stored anywhere.
   */
  const [openCards, setOpenCards] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setOpenCards((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  /*
   * SEARCH AND FILTER (Wave C, 22 Sep 2026), NOW ONLY WHEN THERE IS SOMETHING TO SEARCH. A lens over
   * the sections that narrows what is drawn and never what the header counts. On an ordinary day the
   * desk holds a handful of cards and four search boxes above them are the clutter she named; past
   * eight cards they earn their place.
   */
  const [filterQ, setFilterQ] = useState("");
  const [filterOwner, setFilterOwner] = useState("");
  const [filterKind, setFilterKind] = useState("");
  const [filterOrigin, setFilterOrigin] = useState<"" | OriginKind>("");
  const filterActive = Boolean(filterQ.trim() || filterOwner || filterKind || filterOrigin);
  const showFilters = live.length > 8 || filterActive;
  const matches = (c: WorkCardRow): boolean => {
    const q = filterQ.trim().toLowerCase();
    if (q && !c.title.toLowerCase().includes(q) && !(c.plain_title ?? "").toLowerCase().includes(q)) return false;
    if (filterOwner) {
      const key = c.owner_type === "UNASSIGNED" ? "UNASSIGNED" : `${c.owner_type}:${c.owner_id ?? ""}`;
      if (key !== filterOwner) return false;
    }
    if (filterKind && (c.kind ?? "") !== filterKind) return false;
    if (filterOrigin && originOf(c, me.id).kind !== filterOrigin) return false;
    return true;
  };
  const needs = sections.needs.filter((e) => matches(e.card));
  const worked = sections.worked.filter((e) => matches(e.card));
  const kindsOnDesk = useMemo(() => Array.from(new Set(live.map((c) => c.kind).filter(Boolean) as string[])).sort(), [live]);

  if (!loaded) {
    return (
      <p className="wc-quiet" data-testid="work-desk-loading" role="status">
        Reading the desk…
      </p>
    );
  }

  const row = ({ card: c, status }: DeskEntry): JSX.Element => {
    const isOpen = openCards.has(c.id);
    return (
      <li
        key={c.id}
        className={["wc-card", status.section === "needs" ? "wc-card-needs" : "", status.kind === "WAITING" ? "wc-card-quiet" : "", isOpen ? "is-open" : ""].filter(Boolean).join(" ")}
        data-testid={`work-card-${c.id}`}
        data-live-kind={status.kind}
        data-failing={status.failing ? "yes" : "no"}
      >
        <div className="wc-row" data-testid={`work-card-row-${c.id}`}>
          <RowOwner
            name={c.owner_type === "UNASSIGNED" ? null : (c.owner_name ?? null)}
            partners={[
              ...(c.primary_partner && c.secondary_partner ? [{ first_name: c.primary_partner.first_name, role: "Owner" }] : []),
              ...(c.secondary_partner ? [{ first_name: c.secondary_partner.first_name, role: "Secondary" }] : []),
            ]}
          />
          <div className="wc-row-main">
            <strong className="wc-title" data-testid={`work-card-title-${c.id}`}>
              {c.plain_title ?? c.title}
            </strong>
            <span className="wc-status">
              <StatusPill status={status} testid={`work-card-state-${c.id}`} />
              <span className="wc-line" data-testid={`work-card-status-${c.id}`}>
                {status.line}
              </span>
              {/* WHEN IT WAS FORMED, date and time (27 Sep 2026): four cards from one hour must read apart at a glance. */}
              <span className="wc-quiet" data-testid={`work-card-formed-row-${c.id}`}>
                {" · "}
                {formedStamp(c.created_at)}
              </span>
            </span>
          </div>
          {c.kind === "WEB_PROPERTY_CHANGE" && <SiteTrack card={c} />}
          <ShowEverything id={c.id} open={isOpen} onToggle={() => toggle(c.id)} data-testid={`work-card-toggle-${c.id}`} />
        </div>
        {isOpen && (
          <div className="wc-body" id={`work-card-expanded-${c.id}`} data-testid={`work-card-expanded-${c.id}`}>
            <CardExpanded
              card={c}
              me={me}
              status={status}
              assignable={assignable}
              busy={busy}
              setBusy={setBusy}
              setMessage={setMessage}
              reload={reload}
              onNavigate={onNavigate}
              onMove={onMove}
              mode="desk"
            />
          </div>
        )}
      </li>
    );
  };

  const machineryLine =
    machineryHealth.total === 0
      ? "no jobs on a clock yet"
      : `${machineryHealth.total} job${machineryHealth.total === 1 ? "" : "s"} on a clock, ` +
        (machineryHealth.trouble > 0 ? `${machineryHealth.trouble} need${machineryHealth.trouble === 1 ? "s" : ""} a look` : machineryHealth.never > 0 ? `${machineryHealth.never} not run yet` : "all fine");

  return (
    <>
      {showFilters && (
        <div className="record-controls" data-testid="work-desk-filters">
          <label className="record-field record-field-grow">
            <span className="lbl">Search the desk</span>
            <input type="search" value={filterQ} data-testid="work-desk-search" placeholder="a title, a company, a kind of work…" onChange={(e) => setFilterQ(e.target.value)} />
          </label>
          <label className="record-field">
            <span className="lbl">Owner</span>
            <select data-testid="work-desk-filter-owner" value={filterOwner} onChange={(e) => setFilterOwner(e.target.value)}>
              <option value="">Anyone</option>
              <option value="UNASSIGNED">Nobody</option>
              {(assignable?.employees ?? []).map((emp) => (
                <option key={emp.id} value={`AI:${emp.id}`}>{emp.name}</option>
              ))}
              {(assignable?.partners ?? []).map((p) => (
                <option key={p.id} value={`HUMAN:${p.id}`}>{p.full_name}</option>
              ))}
            </select>
          </label>
          <label className="record-field">
            <span className="lbl">Kind</span>
            <select data-testid="work-desk-filter-kind" value={filterKind} onChange={(e) => setFilterKind(e.target.value)}>
              <option value="">Any kind</option>
              {kindsOnDesk.map((k) => (
                <option key={k} value={k}>{cardKind(k)?.label ?? k}</option>
              ))}
            </select>
          </label>
          <label className="record-field">
            <span className="lbl">Origin</span>
            <select data-testid="work-desk-filter-origin" value={filterOrigin} onChange={(e) => setFilterOrigin(e.target.value as "" | OriginKind)}>
              <option value="">Anywhere</option>
              <option value="EMAIL">Email</option>
              <option value="YOU">You</option>
              <option value="PARTNER">A partner</option>
              <option value="MEETING">A meeting</option>
              <option value="CAPTURE">Something captured</option>
              <option value="ANOTHER_CARD">Handed off</option>
              <option value="SYSTEM">An employee or the sweep</option>
            </select>
          </label>
          {filterActive && (
            <button
              type="button"
              className="link-button"
              data-testid="work-desk-filter-clear"
              onClick={() => {
                setFilterQ("");
                setFilterOwner("");
                setFilterKind("");
                setFilterOrigin("");
              }}
            >
              Clear the filters
            </button>
          )}
        </div>
      )}
      {filterActive && needs.length === 0 && worked.length === 0 && (
        <div className="card" data-testid="work-desk-filter-empty">
          <p>
            <strong>Nothing on the desk matches that.</strong>
          </p>
          <p className="muted small">Widen the search or clear the filters — nothing has been removed from the desk itself.</p>
        </div>
      )}

      {/* NEEDS YOU FIRST: the decks waiting on her decision, then the cards stopped on her. */}
      {(decksWaiting.length > 0 || needs.length > 0) && (
        <section className="work-region" data-testid="work-owner-needs">
          <div className="work-band-head">
            <h3>Needs you</h3>
            <p className="work-band-note">Nothing on these moves until you act.</p>
          </div>
          <ul className="wc-list" data-testid="work-card-list-needs">
            {decksWaiting.map((v) => {
              const isOpen = openCards.has(v.id);
              return (
                <li key={v.id} className={isOpen ? "wc-card wc-card-needs is-open" : "wc-card wc-card-needs"} data-testid={`work-deck-${v.id}`}>
                  <div className="wc-row">
                    <RowOwner name={v.created_by} />
                    <div className="wc-row-main">
                      <strong className="wc-title">
                        {v.title}, version {v.version_no}
                      </strong>
                      <span className="wc-status">
                        <span className="wc-pill wc-pill-decision">Your decision</span>
                        <span className="wc-line">
                          {v.change_summary ? `${firstSentence(v.change_summary, 80)} · ` : ""}waiting since {shortDate(v.created_at)}
                        </span>
                      </span>
                    </div>
                    <button type="button" className="btn-strong wc-decide" data-testid={`work-deck-decide-${v.id}`} onClick={() => onNavigate("fund-strategy")}>
                      Look and decide
                    </button>
                    <ShowEverything id={v.id} open={isOpen} onToggle={() => toggle(v.id)} data-testid={`work-deck-toggle-${v.id}`} />
                  </div>
                  {isOpen && (
                    <div className="wc-body" id={`work-card-expanded-${v.id}`}>
                      <div className="wc-expanded">
                        <section className="wc-section">
                          <h4 className="wc-label">What changed</h4>
                          <p>{v.change_summary ?? "No summary was written for this version."}</p>
                        </section>
                        <dl className="wc-details">
                          <dt>Built by</dt>
                          <dd>{v.created_by}</dd>
                          <dt>Proposed</dt>
                          <dd>{shortDate(v.created_at)}</dd>
                          <dt>Deciding</dt>
                          <dd>Approve it or send it back on Fund strategy — sending it back opens the next card for Preston.</dd>
                        </dl>
                        {v.document_id && (
                          <div className="wc-foot-actions">
                            <button
                              type="button"
                              data-testid={`work-deck-view-${v.id}`}
                              onClick={() => {
                                try {
                                  window.sessionStorage.setItem("wpos.documents.focus", v.document_id!);
                                } catch {
                                  /* fine */
                                }
                                onNavigate("documents");
                              }}
                            >
                              Open version {v.version_no}
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
            {needs.map(row)}
          </ul>
        </section>
      )}

      {worked.length > 0 && (
        <section className="work-region" data-testid="work-owner-worked">
          <div className="work-band-head">
            <h3>Being worked</h3>
            <p className="work-band-note">Nothing to do here. A pulsing dot means it is running this minute.</p>
          </div>
          <ul className="wc-list" data-testid="work-card-list-worked">
            {worked.map(row)}
          </ul>
        </section>
      )}

      {/* WHEN THE DESK IS CLEAR — designed rather than left blank. */}
      {answerIsClear && needs.length === 0 && decksWaiting.length === 0 && live.length > 0 && !filterActive && (
        <p className="work-clear-line" data-testid="work-desk-clear">
          Nothing needs you.
        </p>
      )}

      {live.length === 0 && decksWaiting.length === 0 && !adding && (
        <div className="card" data-testid="work-cards-empty">
          <h4>Nothing is open</h4>
          <p className="small">
            A work card is a piece of work somebody owns, with a next action. It is not a notification — that just says
            look at this — and not an approval, which is a decision waiting on you.
          </p>
          <p className="muted small">Cards arrive five ways:</p>
          <ul className="card-list small" data-testid="work-card-sources">
            {CARD_SOURCES.map((src) => (
              <li key={src.key}>
                <strong>{src.label}</strong> — {src.how}
                {src.page && (
                  <>
                    {" "}
                    <button type="button" className="link-button" onClick={() => onNavigate(src.page!)}>
                      Open
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* THE OTHER TWO KINDS, NAMED AND LEFT ALONE — a quiet footer, not two tiles. */}
      <footer className="wc-elsewhere" data-testid="work-elsewhere">
        <button type="button" className="link-button" data-testid="work-goto-record" onClick={() => onGoto("record")}>
          The record: everything finished
        </button>
        <button type="button" className="link-button" data-testid="work-goto-machinery" onClick={() => onGoto("machinery")}>
          <span data-testid="work-machinery-health">The machinery: {machineryLine}</span>
        </button>
      </footer>
    </>
  );
}
