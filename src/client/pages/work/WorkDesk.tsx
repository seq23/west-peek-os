import { useMemo, useState } from "react";
import { shortDate } from "../../lib/dates";
import { api, type MeResponse } from "../../lib/api";
import { CARD_SOURCES, STATE_MEANINGS, heldBySentence, stateMeaning } from "@shared/work/workCards";
import type { BlockActionKey } from "@shared/work/blocks";
import { originOf, originBadgeText, type OriginKind } from "@shared/work/origin";
import { cardKind } from "@shared/work/cardKinds";
import { portraitFor } from "../../lib/employeePortraits";
import { ArtifactShelf } from "../ArtifactShelf";
import { WebPropertyChangePanel } from "../WebPropertyChangePanel";
import { BlockPanel } from "./BlockPanel";
import { LookForm, LookResults } from "./LooksPanel";
import { NotesPanel, SteerButton } from "./NotesPanel";
import type { Assignable, InstructionReceipt, RecentRun, WorkCardNote, WorkCardRow } from "./types";

/** How recently a card must have been opened to read as "just started" on the desk. */
const JUST_STARTED_MS = 15 * 60 * 1000;

/**
 * THE DESK — what needs you, what is in flight, and where the other two addresses went.
 *
 * Moved out of `WorkCardsPage.tsx` on 22 Sep 2026 with NO behaviour change: the shell above still
 * owns the masthead, the tabs, the one board fetch and the card-state moves the record shares, and
 * hands this component what it already had. Every `data-testid`, every route, every condition and
 * every sentence is the one that shipped.
 */

export interface DeskBand {
  key: string;
  density: "card" | "row";
  name: string;
  note: string;
  cards: WorkCardRow[];
}

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

/**
 * TWO BANDS ON THE DESK, AT TWO DENSITIES — and the density is the separation.
 *
 * Three bands at one weight is what the page had, and it is why a card being quietly worked by an
 * employee read as loudly as a card that had stopped dead. Waiting work is the only thing she can
 * act on, so it gets the full card: the block sentences, the recovery doors, the labels. Work in
 * flight is something she reads and leaves alone, so it gets one line each — she needs to know it
 * is moving, not what it says.
 *
 * THE PARTNER'S WORK IS IN FLIGHT, NOT A THIRD BAND. Its own heading answered "who has it", which
 * is not the question this page is opened with; somebody is on it either way, and the owner's
 * face on the row says which somebody.
 *
 * Exported as a pure function because the masthead above the tabs counts what is waiting. One
 * rule, read twice — never two lists each keeping their own idea of what "waiting" means.
 */
export function deskBands(live: WorkCardRow[], meId: string): DeskBand[] {
  const waiting: WorkCardRow[] = [];
  const flight: WorkCardRow[] = [];
  for (const c of live) {
    const mine = c.owner_type === "HUMAN" && c.owner_id === meId;
    const nobody = c.owner_type === "UNASSIGNED" || !c.owner_id;
    // HELD (0227, Wave D) sits with "waiting on you" rather than "in flight" — nothing is being
    // worked, and it is silent (no nag) precisely because she already knows: she is the one who
    // put it there. It still belongs on the desk she reads every time, not hidden.
    if (c.state === "BLOCKED" || c.state === "HELD" || nobody || mine) waiting.push(c);
    else flight.push(c);
  }
  return [
    {
      key: "waiting",
      density: "card" as const,
      name: "Waiting on you",
      note: "blocked, unowned, or yours — nothing moves until you act",
      cards: waiting,
    },
    {
      key: "flight",
      density: "row" as const,
      name: "In flight",
      note: "being worked right now — the sweep picks each one up within five minutes and it ends Done or Blocked. A blocked one moves up to Waiting on you.",
      cards: flight,
    },
  ].filter((b) => b.cards.length > 0);
}

/**
 * Who is carrying a card, with their face.
 *
 * Reused across the board rather than inlined, because the same chip belongs anywhere a piece of
 * work is attributed. Falls back to initials, and says "Nobody" rather than nothing — an unowned
 * card is a real state and the one most worth spotting.
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

export function WorkDesk({
  me,
  bands,
  live,
  runs,
  decksWaiting,
  assignable,
  answerIsClear,
  adding,
  busy,
  setBusy,
  setMessage,
  reload,
  onChanged,
  onNavigate,
  onMove,
  onGoto,
  machineryHealth,
  deskSeenAt,
}: {
  me: MeResponse;
  bands: DeskBand[];
  live: WorkCardRow[];
  runs: RecentRun[];
  decksWaiting: DeckWaiting[];
  assignable: Assignable | null;
  /** Whether the masthead answer is "nothing is waiting" — the designed empty state below. */
  answerIsClear: boolean;
  adding: boolean;
  busy: boolean;
  setBusy: (next: boolean) => void;
  setMessage: (next: string | null) => void;
  reload: () => void;
  onChanged: () => void;
  onNavigate: (k: string) => void;
  /** Moving a card belongs to the shell, because the record view moves cards through it too. */
  onMove: (id: string, state: string) => void;
  onGoto: (view: "record" | "machinery") => void;
  machineryHealth: MachineryHealth;
  /** WAVE C (22 Sep 2026): the moment she last looked at this desk, or null the first time ever. */
  deskSeenAt: string | null;
}): JSX.Element {
  const [looking, setLooking] = useState<string | null>(null);
  /**
   * WHICH CARD YOU ARE SAYING SOMETHING TO, and what has already been said on it.
   *
   * The note itself has existed since 22 Aug — the table, both routes, and the employee loop that
   * re-reads unanswered notes on every step and must answer them to mark them seen. What never
   * existed was any way to leave one. The operator asked for this in her own words and it shipped
   * as API surface with no screen, which is the same failure as an approval you cannot revoke.
   */
  const [steering, setSteering] = useState<string | null>(null);
  const [noteText, setNoteText] = useState("");
  const [notes, setNotes] = useState<Record<string, WorkCardNote[]>>({});
  const [receipts, setReceipts] = useState<Record<string, InstructionReceipt[]>>({});
  /**
   * WHICH CARDS ARE OPEN, by id. Collapsed is the default and that is the whole point: a board with
   * twenty cards on it, each carrying a next action, an origin line, an owner line, an assignment
   * control and four buttons, is several screens tall before you have read anything. You come to
   * this page to see WHAT the firm is carrying; the detail of any one card is a second question.
   *
   * Opening a card is not stored anywhere. It is a reading position, not a preference, and a card
   * you left open last Tuesday is not information.
   */
  const [openCards, setOpenCards] = useState<ReadonlySet<string>>(new Set());
  /** Cards whose full look history has been asked for. Two are shown otherwise. */
  const [showAllLooks, setShowAllLooks] = useState<ReadonlySet<string>>(new Set());
  const toggleCard = (id: string) =>
    setOpenCards((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  /**
   * THE BLOCK YOU ARE CLEARING, and what you are typing into it.
   *
   * Operator, 16 Sep 2026: "parker is blocked … i dont understand what he is blocked on and how to
   * help him myself." A blocked card now opens its own panel whether or not the card is expanded —
   * it is the one state where the card is a question addressed to you, and making you press a
   * chevron first to find that out is the same dead end with an extra click.
   */
  const [clearing, setClearing] = useState<{ card: string; action: BlockActionKey } | null>(null);
  const [clearText, setClearText] = useState("");
  const [lookObjective, setLookObjective] = useState("");
  const [lookUrl, setLookUrl] = useState("");

  /**
   * SEARCH AND FILTER, ON THE DESK ITSELF (Wave C, 22 Sep 2026) — not only the Record tab, which
   * only ever searched finished work. Purely a viewing lens over `bands`: it narrows which of the
   * cards already on the desk are rendered, and never changes what the masthead's answer counts —
   * that stays a fact about what actually needs her, not about what she happens to be looking at
   * right now.
   */
  const [filterQ, setFilterQ] = useState("");
  const [filterOwner, setFilterOwner] = useState("");
  const [filterKind, setFilterKind] = useState("");
  const [filterOrigin, setFilterOrigin] = useState<"" | OriginKind>("");
  const filterActive = Boolean(filterQ.trim() || filterOwner || filterKind || filterOrigin);

  const matchesFilter = (c: WorkCardRow): boolean => {
    if (filterQ.trim() && !c.title.toLowerCase().includes(filterQ.trim().toLowerCase())) return false;
    if (filterOwner) {
      const cardKey = c.owner_type === "UNASSIGNED" ? "UNASSIGNED" : `${c.owner_type}:${c.owner_id ?? ""}`;
      if (cardKey !== filterOwner) return false;
    }
    if (filterKind && (c.kind ?? "") !== filterKind) return false;
    if (filterOrigin && originOf(c, me.id).kind !== filterOrigin) return false;
    return true;
  };

  const visibleBands = useMemo(
    () => bands.map((b) => ({ ...b, cards: b.cards.filter(matchesFilter) })).filter((b) => b.cards.length > 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bands, filterQ, filterOwner, filterKind, filterOrigin],
  );
  /** Distinct kinds actually on the desk right now — a filter offers only choices that do something. */
  const kindsOnDesk = useMemo(() => {
    const seen = new Set<string>();
    for (const c of live) if (c.kind) seen.add(c.kind);
    return Array.from(seen).sort();
  }, [live]);

  /** Hand a card to somebody. The same act whether it is an employee or a partner. */
  async function assign(id: string, ownerType: string, ownerId: string) {
    const res = await api<{ error?: string; detail?: string }>(`/api/work-cards/${id}`, {
      method: "PATCH",
      body: { owner_type: ownerType, owner_id: ownerId },
    });
    if (res.status !== 200) setMessage(`Could not reassign it: ${res.data?.detail ?? res.data?.error ?? res.status}`);
    reload();
    onChanged();
  }

  /** Ask for a page to be read for this card. Runs now if the card permits it. */
  async function look(cardId: string) {
    if (lookObjective.trim().length < 8) return;
    setBusy(true);
    const res = await api<{ ran?: boolean; ok?: boolean; detail?: string; error?: string }>(
      `/api/work-cards/${cardId}/look`,
      {
        method: "POST",
        body: {
          objective: lookObjective.trim(),
          ...(lookUrl.trim().length >= 8 ? { start_url: lookUrl.trim() } : {}),
        },
      },
    );
    setBusy(false);
    setMessage(
      res.status === 201
        ? res.data?.ran
          ? `Looked: ${res.data.detail ?? "done"}`
          : (res.data?.detail ?? "Raised for approval.")
        : `Could not: ${res.data?.detail ?? res.data?.error ?? res.status}`,
    );
    if (res.status === 201) { setLooking(null); setLookObjective(""); setLookUrl(""); }
    reload();
  }

  /** Give (or withdraw) this card standing permission to read pages. */
  async function grantBrowser(cardId: string, allow: boolean) {
    const res = await api<{ detail?: string }>(`/api/work-cards/${cardId}/browser-permission`, {
      method: "POST",
      body: { allows_browser: allow },
    });
    setMessage(res.data?.detail ?? null);
    reload();
  }

  /**
   * Clear a block. The answer is not a comment: the server reopens the card, resets its attempts
   * and puts what you typed where the employee reads it on their next run.
   */
  async function clearBlock(id: string, action: BlockActionKey, choice?: string) {
    setBusy(true);
    const res = await api<{ ok?: boolean; said?: string }>(`/api/work-cards/${id}/unblock`, {
      method: "POST",
      body: { action, ...(clearText.trim() ? { text: clearText.trim() } : {}), ...(choice ? { choice } : {}) },
    });
    setBusy(false);
    setMessage(res.data?.said ?? "Could not do that.");
    if (res.data?.ok) { setClearing(null); setClearText(""); }
    reload();
    onChanged();
  }

  /**
   * DO IT NOW, FROM THE DESK ROW (Wave C, 22 Sep 2026) — the same door the card page's masthead
   * already opens (`POST /api/work-cards/:id/work`, Wave A's `doItNow`), reused rather than
   * reimplemented, so a card no longer needs its own page open just to be started ahead of the
   * sweep's five-minute cycle.
   */
  async function doItNow(id: string) {
    setBusy(true);
    const res = await api<{ error?: string; detail?: string }>(`/api/work-cards/${id}/work`, { method: "POST" });
    setBusy(false);
    setMessage(res.status === 200 ? (res.data?.detail ?? "Started.") : `Could not start it: ${res.data?.detail ?? res.data?.error ?? res.status}`);
    reload();
    onChanged();
  }

  /**
   * "SHOW ME FIRST", FROM THE DESK ROW, MID-FLIGHT (Wave C, 22 Sep 2026) — she asked for this
   * without having to open the card. The column (`work_card.preview_first`) and the door
   * (`updateWorkCardSchema`'s `preview_first`, `services/workCards.ts`) already existed; only this
   * control was missing.
   */
  async function togglePreviewFirst(c: WorkCardRow) {
    const next = c.preview_first !== 1;
    const res = await api<{ error?: string; detail?: string }>(`/api/work-cards/${c.id}`, {
      method: "PATCH",
      body: { preview_first: next },
    });
    if (res.status !== 200) setMessage(`Could not change that: ${res.data?.detail ?? res.data?.error ?? res.status}`);
    else setMessage(next ? "You will see this one before it goes out." : "No longer held for your preview.");
    reload();
  }

  /** What has been said on a card, loaded only when you open the form — never on every render. */
  async function openSteering(id: string) {
    if (steering === id) { setSteering(null); return; }
    setSteering(id);
    setNoteText("");
    // BOTH HALVES OF THE CONVERSATION, in one open. The notes are what she said; the receipts are
    // what a model made of everything she has said on this card. Fetched together because reading
    // one without the other is how "he ignored me" and "he misread me" look identical.
    const [res, rec] = await Promise.all([
      api<{ notes: WorkCardNote[] }>(`/api/work-cards/${id}/notes`),
      api<{ receipts: InstructionReceipt[] }>(`/api/work-cards/${id}/instructions`),
    ]);
    setNotes((n) => ({ ...n, [id]: res.data?.notes ?? [] }));
    setReceipts((r) => ({ ...r, [id]: rec.data?.receipts ?? [] }));
  }

  async function sendNote(id: string) {
    const res = await api<{ error?: string; detail?: string }>(`/api/work-cards/${id}/notes`, {
      method: "POST",
      body: { body: noteText },
    });
    if (res.status !== 201) {
      setMessage(res.data?.detail ?? `Could not leave that note (${res.status}).`);
      return;
    }
    // The work is NOT stopped and the board is not reloaded: the whole point is that steering
    // something in motion does not interrupt it. Only this card's thread changes.
    setNoteText("");
    const fresh = await api<{ notes: WorkCardNote[] }>(`/api/work-cards/${id}/notes`);
    setNotes((n) => ({ ...n, [id]: fresh.data?.notes ?? [] }));
    setMessage("Passed on. They will pick it up on their next step and say what they changed.");
  }

  return (
    <>
      {/* THE THING WAITING ON YOU COMES FIRST. The header said "1 waiting on you" and the deck it
          meant sat under the legend, the add form and the empty-state explainer — "i have 1 waiting
          for me item ... and i have no idea what the item is" (14 Sep). What the count counts is
          the next thing on the page. */}
      {decksWaiting.length > 0 && (
        <section data-testid="work-decks-waiting" className="work-region">
          <div className="work-band-head">
            <h3>
              A deck is waiting on your decision <span className="count-pill">{decksWaiting.length}</span>
            </h3>
            <p className="work-band-note">look at it, then approve it or send it back — sending it back opens the next card for Preston</p>
          </div>
          <ul className="card-list">
            {decksWaiting.map((v) => (
              <li key={v.id} className="card" data-testid={`work-deck-${v.id}`}>
                <strong>v{v.version_no} — {v.title}</strong>{" "}
                <span className="muted small">by {v.created_by}, {new Date(v.created_at).toLocaleString()}</span>
                {v.change_summary && <p className="small">{v.change_summary}</p>}
                <div className="notification-actions">
                  {v.document_id && (
                    <button type="button" className="link-button" onClick={() => {
                      try { window.sessionStorage.setItem("wpos.documents.focus", v.document_id!); } catch { /* fine */ }
                      onNavigate("documents");
                    }}>
                      View v{v.version_no}
                    </button>
                  )}
                  <button type="button" className="btn-strong" onClick={() => onNavigate("fund-strategy")}>
                    Decide on Fund strategy
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      {/* THE LEGEND BELONGS BEFORE THE THING IT EXPLAINS — it used to sit at the very bottom, under
          every card, so the words telling you what "Blocked" means were below the blocked card you
          were reading. But five rows of definitions expanded at the top pushed the cards themselves
          off the screen, which is the opposite failure. So: before the cards, and closed, because a
          legend is something you consult once and then never again. */}
      <details className="work-legend-wrap" data-testid="work-state-legend">
        <summary className="muted small">What the states mean</summary>
        <ul className="work-legend">
          {STATE_MEANINGS.map((m) => (
            <li key={m.key}>
              <span className={m.key === "BLOCKED" ? "badge badge-bad" : m.key === "DONE" ? "badge badge-ok" : "badge"}>
                {m.label}
              </span>
              <span className="muted small">{m.means}</span>
            </li>
          ))}
        </ul>
      </details>

      {/*
        SEARCH AND FILTER, ON THE DESK ITSELF (Wave C, 22 Sep 2026). The Record tab already
        searches — but only what has finished. This is the same question asked of what is still
        live: which owner, which kind, where it came from. A client-side lens over `bands`, because
        the whole live board is already in hand — no second request to narrow a list this short.
      */}
      {live.length > 0 && (
        <div className="record-controls" data-testid="work-desk-filters">
          <label className="record-field record-field-grow">
            <span className="lbl">Search the desk</span>
            <input
              type="search"
              value={filterQ}
              data-testid="work-desk-search"
              placeholder="a title, a company, a kind of work…"
              onChange={(e) => setFilterQ(e.target.value)}
            />
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

      {filterActive && visibleBands.length === 0 && live.length > 0 && (
        <div className="card" data-testid="work-desk-filter-empty">
          <p>
            <strong>Nothing on the desk matches that.</strong>
          </p>
          <p className="muted small">Widen the search or clear the filters — nothing has been removed from the desk itself.</p>
        </div>
      )}

      {/*
        WHEN THE DESK IS CLEAR. This is the state on most days and it is designed rather than left
        blank — a page that empties out reads as broken, and "nothing is waiting" is the single most
        valuable thing this surface can tell her. It says what would have to happen for something to
        arrive here, so she can believe the silence.
      */}
      {answerIsClear && bands.length === 0 && decksWaiting.length === 0 && (
        <div className="work-clear" data-testid="work-desk-clear">
          <p className="work-clear-line">Nothing is waiting on you.</p>
          <p className="muted small">
            Something arrives here when an employee finishes work that needs your signature, or stops on a
            question only you can answer. The count beside <strong>Desk</strong> above turns orange the moment
            it does.
          </p>
        </div>
      )}

      {live.length === 0 && decksWaiting.length === 0 && runs.length === 0 && !adding && (
        <div className="card" data-testid="work-cards-empty">
          <h4>Nothing is open</h4>
          <p className="small">
            A work card is a piece of work somebody owns, with a next action. It is not a
            notification — that just says look at this — and not an approval, which is a decision
            waiting on you.
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
          <p className="muted small">
            A scheduled job does not get a card, because a job is machinery rather than a task
            somebody owns. What a job produces can become one.
          </p>
        </div>
      )}

      {visibleBands.map((group) => (
        <section key={group.key} data-testid={`work-owner-${group.key}`} className="work-region">
          <div className="work-band-head">
            <h3>
              {group.name} <span className="count-pill">{group.cards.length}</span>
            </h3>
            <p className="work-band-note">{group.note}</p>
          </div>

          <ul
            className={group.density === "row" ? "work-card-list work-card-rows" : "work-card-grid"}
            data-testid={`work-card-list-${group.key}`}
          >
            {group.cards.map((c) => {
              const meaning = stateMeaning(c.state);
              const isOpen = openCards.has(c.id);
              /*
                A CARD THAT IS STUMBLING IS NOT A CARD THAT IS WAITING, and on 17 Sep 2026 they
                looked identical. Parker's event-kit card burned three attempts in fourteen minutes
                against a lane that had run out of credit, and every time the owner looked it said
                "Open · queued — picked up within 5 min". `work_attempts` was counting the whole
                time and nothing on this page read it out.

                So a card with a failure behind it says so — in the badge row, in its own colour,
                before anything is expanded — and the reassuring "queued" line is suppressed,
                because it is not true of this card.
              */
              const failing = Boolean(c.work_last_failure) && c.state !== "BLOCKED" && c.state !== "DONE" && c.state !== "CANCELLED";
              /*
               * RECENCY AND ORIGIN, READ WITHOUT OPENING THE CARD (Wave C, 22 Sep 2026).
               * `originOf` is the same function the card's own page reads (`@shared/work/origin`,
               * built in Wave A) — the desk asks it the same question rather than guessing again.
               * `deskSeenAt` comes from `work_desk_seen` (migration 0225), which existed with no
               * reader until this page.
               */
              const origin = originOf(c, me.id);
              const originText = originBadgeText(origin, c.created_by_ai_name ?? null);
              const justStarted = Date.now() - Date.parse(c.created_at) < JUST_STARTED_MS;
              const newSinceVisit = Boolean(deskSeenAt) && Date.parse(c.created_at) > Date.parse(deskSeenAt as string);
              // "DO IT NOW" IS OFFERED WHEN THE SWEEP HAS NOT TOUCHED IT YET — the same reading the
              // "queued — picked up within 5 min" line below already uses, so the button and the
              // sentence never disagree about whether a card has started.
              const notStarted = c.owner_type === "AI" && c.state === "OPEN" && !failing && (c.work_attempts ?? 0) === 0;
              // "SHOW ME FIRST" IS OFFERED WHILE THE CARD IS ACTUALLY IN FLIGHT — the same gate
              // `SteerButton` already uses, because pulling something into preview only means
              // something for work that is still moving.
              const canTogglePreview = c.owner_type === "AI" && ["OPEN", "IN_PROGRESS", "BLOCKED"].includes(c.state);
              const previewOn = c.preview_first === 1;
              const rowClass = [
                "card",
                "work-card-row",
                // THE DENSITY IS THE SEPARATION. A card she must act on is a card; a card being
                // worked is one line, because she reads it and leaves it alone.
                group.density === "row" ? "work-card-lean" : "",
                isOpen ? "is-open" : "",
                failing ? "work-card-failing" : "",
              ]
                .filter(Boolean)
                .join(" ");
              return (
                <li key={c.id} className={rowClass} data-testid={`work-card-${c.id}`} data-failing={failing ? "yes" : "no"}>
                  {/*
                    THE CARD AT REST IS THREE LINES, not one and not fifteen.

                    Collapsing it to a single line fixed the length and broke the form — a grid of
                    one-line strips reads as a list of chips, and the operator's verdict was that
                    they no longer looked like cards. Three lines is the size where a card is
                    recognisably a card and six still fit above the fold: what state it is in, what
                    it is, and who is carrying it with what happens next.

                    The header is the toggle. A target you have to aim at is worse than the row you
                    were already reading.
                  */}
                  <button
                    type="button"
                    className="work-card-summary"
                    aria-expanded={isOpen}
                    data-testid={`work-card-toggle-${c.id}`}
                    onClick={() => toggleCard(c.id)}
                  >
                    <span className="work-card-meta">
                      <span
                        className={c.state === "BLOCKED" ? "badge badge-bad" : c.state === "HELD" ? "badge badge-quiet" : "badge"}
                        data-testid={`work-card-state-${c.id}`}
                      >
                        {meaning?.label ?? c.state}
                      </span>
                      {/* HOW FAR ALONG. An employee gets three attempts; the count is what tells you
                          "in progress" is a run that happened rather than a label that stuck. */}
                      {failing && (
                        <span className="badge badge-bad" data-testid={`work-card-failing-${c.id}`}>
                          last try failed
                        </span>
                      )}
                      {c.owner_type === "AI" && c.state === "IN_PROGRESS" && (
                        <span className="muted small">attempt {Math.max(1, c.work_attempts ?? 1)} of 3</span>
                      )}
                      {/* NOT SAID OF A CARD THAT HAS ALREADY FAILED. "Queued — picked up within
                          5 min" is a reassurance, and repeating it over a card that has been
                          refused twice is the exact lie the owner was reading all evening. */}
                      {c.owner_type === "AI" && c.state === "OPEN" && !failing && (
                        <span className="muted small">queued — picked up within 5 min</span>
                      )}
                      {c.priority !== "NORMAL" && <span className="badge badge-gate">{c.priority.toLowerCase()}</span>}
                      {/* RECENCY (Wave C). "New" wins over "just started" when both are true — the
                          more specific fact, since it is the one built on what she has actually
                          seen rather than the clock alone. */}
                      {newSinceVisit ? (
                        <span className="badge badge-attention" data-testid={`work-card-new-${c.id}`} title="Created since you last opened the desk">
                          new
                        </span>
                      ) : justStarted ? (
                        <span className="badge badge-attention" data-testid={`work-card-juststarted-${c.id}`} title="Opened in the last 15 minutes">
                          just started
                        </span>
                      ) : null}
                      {/* ORIGIN (Wave C) — from email (naming the sender), from her, from a partner,
                          from a meeting or capture, handed off, or from an employee or the
                          scheduled sweep. Reuses `originOf`/`originBadgeText`, built for the card
                          page, rather than a second reading of the same six columns. */}
                      <span className="badge" data-testid={`work-card-origin-${c.id}`}>
                        {originText}
                      </span>
                      {/*
                          BOTH LABELS, ALWAYS, AND THE LANE BESIDE THEM.

                          "they should include sensitivity public or private and audience: internal
                          or external ON THE CARD so we can have a trail of how it's working."

                          Badging only the exceptions was the cheaper design and it answers the
                          wrong question. A trail has to be readable on the ordinary card too —
                          otherwise "did this go where I expected?" is unanswerable for exactly the
                          cards that make up the bill. So both labels show on every card, and the
                          model that actually ran shows next to them.
                      */}
                      <span
                        className={c.model_access === "PRIVATE_MODEL_ONLY" ? "badge badge-gate" : "badge"}
                        data-testid={`work-card-model-access-${c.id}`}
                        title={
                          c.model_access === "PRIVATE_MODEL_ONLY"
                            ? "LP names, deal terms, fund figures or diligence material — this stays on a model whose terms forbid training on it"
                            : "No LP names or deal terms, so a free reasoning model may do it. This is the normal case."
                        }
                      >
                        {c.model_access === "PRIVATE_MODEL_ONLY" ? "private model only" : "public model approved"}
                      </span>
                      <span
                        className="badge"
                        data-testid={`work-card-audience-${c.id}`}
                        title={
                          c.audience === "EXTERNAL"
                            ? "Goes to somebody other than Sequoia or Scooter, so it previews to Sequoia before it leaves. This says nothing about which model runs it."
                            : "Goes to Sequoia or Scooter. This says nothing about which model runs it."
                        }
                      >
                        {c.audience === "EXTERNAL" ? "external" : "internal"}
                      </span>
                      {/* WHAT THE LABEL ACTUALLY CAUSED. A free lane is named as free, in words,
                          because ":free" on the end of a model id is not something anybody should
                          have to know to read their own cost. */}
                      {c.last_run?.model && (
                        <span
                          className="muted small"
                          data-testid={`work-card-lane-${c.id}`}
                          title={`Last run ${new Date(c.last_run.at).toLocaleString()} on ${c.last_run.provider_key ?? "an unnamed provider"}/${c.last_run.model}`}
                        >
                          ran on{" "}
                          {c.last_run.model.includes(":free") || c.last_run.provider_key?.endsWith("_free")
                            ? "a free model"
                            : c.last_run.model}
                          {typeof c.last_run.cost_usd === "number" && (c.last_run.cost_usd === 0 ? " — $0" : ` — $${c.last_run.cost_usd.toFixed(4)}`)}
                        </span>
                      )}
                      {/* Two facts survive the collapse because they change what you do next. */}
                      {/* "12 looks" meant nothing to anybody — the operator's question was
                          literally "what is a fucking look?". It is a web page this card opened
                          and read. Say that. */}
                      {(c.looks ?? []).length > 0 && (
                        <span className="muted small" title="Web pages this card has opened and read">
                          {c.looks!.length} page{c.looks!.length === 1 ? "" : "s"} read
                        </span>
                      )}
                      {c.due_at && <span className="muted small">due {shortDate(c.due_at)}</span>}
                      {/* RECENCY (Wave C). `created_at` was fetched and never shown — the plan's own
                          finding. Shown here, not only in the expanded body, because when a card
                          arrived is part of reading the row, not a detail you go looking for. */}
                      <span className="muted small" data-testid={`work-card-created-${c.id}`}>
                        created {shortDate(c.created_at)}
                      </span>
                      <span className={`work-card-chevron${isOpen ? " is-open" : ""}`} aria-hidden="true">›</span>
                    </span>

                    <strong className="work-card-title">{c.title}</strong>

                    {/* WHO, WITH A FACE. Every employee has a portrait now, and a face is the
                        fastest way to read a board — you find Wyatt's cards by looking for Wyatt,
                        not by reading eight owner lines. */}
                    <span className="work-card-foot">
                      <OwnerChip name={c.owner_type === "UNASSIGNED" ? null : c.owner_name ?? null} />
                      {/* A blocked card's next action IS the block sentence, and the panel below
                          says it properly with its buttons. Twice is noise. */}
                      {c.next_action && !c.block && <span className="muted small work-card-next">{c.next_action}</span>}
                    </span>
                  </button>

                  {/*
                    "DO IT NOW" AND "SHOW ME FIRST", WITHOUT OPENING THE CARD (Wave C, 22 Sep 2026).
                    Both sit outside the fold, as siblings of the summary button rather than inside
                    it — a `<button>` cannot nest another interactive control. "Do it now" calls the
                    same `POST /api/work-cards/:id/work` Wave A's card-page masthead already calls;
                    "Show me first" flips the same `preview_first` column that page already reads.
                  */}
                  {(notStarted || canTogglePreview) && (
                    <div className="notification-actions" data-testid={`work-card-desk-actions-${c.id}`}>
                      {notStarted && (
                        <button
                          type="button"
                          className="btn-strong"
                          disabled={busy}
                          data-testid={`work-card-doitnow-${c.id}`}
                          title="Starts it now, ahead of the sweep's next five-minute pass"
                          onClick={() => void doItNow(c.id)}
                        >
                          Do it now
                        </button>
                      )}
                      {canTogglePreview && (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-2xs)" }}>
                          <button
                            type="button"
                            className="switch"
                            role="switch"
                            aria-checked={previewOn}
                            aria-label={`Show ${c.owner_name ?? "this"}'s finished work to you before it leaves, on ${c.title}`}
                            disabled={busy}
                            data-testid={`work-card-previewtoggle-${c.id}`}
                            title={previewOn ? "You will see this before it goes out — click to turn off" : "Pull this into your preview lane before it goes out"}
                            onClick={() => void togglePreviewFirst(c)}
                          >
                            <i aria-hidden="true" />
                          </button>
                          <span className="small">{previewOn ? "Showing you first" : "Show me first"}</span>
                        </span>
                      )}
                    </div>
                  )}

                  {/*
                    THE FAILURE, BEFORE IT BECOMES A BLOCK. One line, outside the fold, in the same
                    place a block would be — because a card that has already been refused once is a
                    card she may want to touch now rather than in ten minutes' time.
                  */}
                  {failing && (
                    <p className="card-failing-line small" data-testid={`work-card-failure-${c.id}`}>
                      {c.work_last_failure} It is being tried again; if it fails again it stops and asks you.
                    </p>
                  )}

                  {/* AN ARTIFACT CARD'S DELIVERABLE IS THE ARTIFACT (19 Sep 2026): the row names what
                      was built, its state in words while it moves, and opens it under Documents. */}
                  {c.kind === "ARTIFACT" && (
                    <div className="card-block" data-testid={`work-card-artifact-${c.id}`}>
                      <p className="lbl">What it builds</p>
                      <ArtifactShelf card={c.id} showObject emptyNote="Nothing has been built yet — the next run opens the build; the row fills in from there." testId={`work-card-artifact-rows-${c.id}`} />
                    </div>
                  )}

                  {/* PORTER'S WEB PROPERTY CHANGE (20 Sep 2026, Plan A): where it is — phase, folder,
                      the plan as a Document, decided and asked, the PR and its checks, the merge and
                      the live proof. The kind's STANDING rules moved off the card (Addendum 1, Wave
                      A, 22 Sep 2026) — they are policy for every card of this kind, not this card's
                      own setting, and the pointer at the foot of the card's own page links there. */}
                  {c.kind === "WEB_PROPERTY_CHANGE" && (
                    <WebPropertyChangePanel cardId={c.id} onNavigate={onNavigate} canEdit={me.roles.includes("MANAGING_PARTNER")} />
                  )}

                  {/*
                    THE BLOCK, OUTSIDE THE FOLD. Everything else on a card is detail you go looking
                    for; a block is a question addressed to you, and it reads before you open
                    anything. Four sentences in the order a person asks them — what was this, what
                    stopped, what would fix it, who can — and then the doors.
                  */}
                  <BlockPanel
                    card={c}
                    employees={assignable?.employees ?? []}
                    busy={busy}
                    clearing={clearing}
                    setClearing={setClearing}
                    clearText={clearText}
                    setClearText={setClearText}
                    onClear={(id, action, choice) => void clearBlock(id, action, choice)}
                  />

                  {/*
                    HELD (0227, Wave D), OUTSIDE THE FOLD LIKE A BLOCK — but never a nag. This is the
                    one sentence that says a card is paused ON PURPOSE, and it reads before opening
                    anything for the same reason a block does: it changes what the row means.
                  */}
                  {c.state === "HELD" && (
                    <p className="notice small" data-testid={`work-card-held-${c.id}`}>
                      {heldBySentence({ held_reason: c.held_reason, held_by_name: c.held_by_name }, c.held_at ? shortDate(c.held_at) : "recently")}{" "}
                      <a href={`#/work/${c.id}`}>Open the card to release it</a>.
                    </p>
                  )}

                  {isOpen && (
                    <>
              <div className="work-card-body">
                {c.next_action && !c.block ? (
                  <div>
                    <p className="lbl">Next</p>
                    {/* Usually one line. When an employee blocks, its whole question lands here,
                        which is a paragraph — so this is bounded like the findings are. */}
                    <div className="work-card-longtext">{c.next_action}</div>
                  </div>
                ) : c.block ? null : (
                  <p className="muted small">No next action — nobody knows what to do with this yet.</p>
                )}
                {/* WHAT IS IN THE DESCRIPTION, and why it needed a box of its own.
                    Two different things land here: where the card came from ("Raised in the weekly
                    review"), which is one line, and everything an employee has established while
                    working it, which grows without limit — Wyatt's card had several thousand
                    characters of search results in it, rendered inline, making one card taller
                    than the rest of the board put together.
                    Labelled so it is not confused with the pages-read count above it, and bounded
                    so a card that has been worked hard is the same height as one that has not. */}
                {c.description && (
                  <div>
                    <p className="lbl">
                      {(c.owner_name ?? "Whoever is carrying this")}
                      {c.description.length > 200 ? " has found so far" : ""}
                    </p>
                    <div className="work-card-longtext" data-testid={`work-card-findings-${c.id}`}>
                      {c.description}
                    </div>
                  </div>
                )}
                <p className="muted small">
                  {c.owner_type === "UNASSIGNED"
                    ? "Nobody owns this"
                    : `Owned by ${c.owner_name ?? c.owner_id ?? c.owner_type.toLowerCase()}`}
                  {c.capture_id ? " · from something you captured" : ""}
                  {c.due_at ? ` · due ${shortDate(c.due_at)}` : ""}
                </p>
              </div>

                  <div className="notification-actions">
                    {/* WAVE A (22 Sep 2026): the card's own page — who asked and how, the message
                        trail, live progress, decisions made without asking, artifacts and previews.
                        The desk stays the working surface; this is where the whole record of one
                        card lives at its own address. */}
                    <a className="link-button" href={`#/work/${c.id}`} data-testid={`work-card-open-${c.id}`}>
                      Open the full card
                    </a>
                    <select
                      aria-label={`Hand ${c.title} to somebody else`}
                      data-testid={`work-card-assign-${c.id}`}
                      value={`${c.owner_type}:${c.owner_id ?? ""}`}
                      onChange={(e) => {
                        const [t, ...rest] = e.target.value.split(":");
                        void assign(c.id, t!, rest.join(":"));
                      }}
                    >
                      <option value="UNASSIGNED:">Nobody</option>
                      {(assignable?.partners ?? []).map((p) => (
                        <option key={p.id} value={`HUMAN:${p.id}`}>{p.full_name}</option>
                      ))}
                      {(assignable?.employees ?? []).map((emp) => (
                        <option key={emp.id} value={`AI:${emp.id}`}>{emp.name}</option>
                      ))}
                    </select>
                    {c.state === "OPEN" && (
                      <button type="button" data-testid={`work-card-start-${c.id}`} onClick={() => onMove(c.id, "IN_PROGRESS")}>
                        Start
                      </button>
                    )}
                    {c.state !== "DONE" && (
                      <button type="button" className="btn-strong" data-testid={`work-card-done-${c.id}`} onClick={() => onMove(c.id, "DONE")}>
                        Done
                      </button>
                    )}
                    {/* DROP. The only way to clear something you had decided NOT to do was to mark
                        it Done, which puts a lie on the record — the state existed in the schema
                        and in the legend, and simply had no button. A decision not to act is still
                        a decision and is kept, not deleted. */}
                    {c.state !== "DONE" && c.state !== "CANCELLED" && (
                      <button
                        type="button"
                        data-testid={`work-card-drop-${c.id}`}
                        title="Deliberately not doing this. Kept on the record."
                        onClick={() => onMove(c.id, "CANCELLED")}
                      >
                        Drop
                      </button>
                    )}
                    {/* SAY SOMETHING TO WHOEVER IS CARRYING IT. Offered only while the work is
                        actually in flight, because the loop re-reads notes only on a card it is
                        still working — a note on finished work would be written into a void, and
                        the server refuses it for the same reason. */}
                    <SteerButton card={c} steering={steering} onOpen={(id) => void openSteering(id)} />
                    {/* LOOKING AT A PAGE BELONGS ON THE CARD THAT NEEDS IT. It used to be a
                        disclosure floating between the bands, answering a question nobody asks at
                        that moment — nobody opens Work wanting to read a webpage, they want to know
                        whether a company still lists a VP of Sales. Zero tasks had ever run. */}
                    {c.state !== "DONE" && c.state !== "CANCELLED" && (
                      <button
                        type="button"
                        data-testid={`work-card-look-${c.id}`}
                        title={c.allows_browser ? "Reads the page now — this card allows it" : "Raises a look for you to approve"}
                        onClick={() => setLooking(looking === c.id ? null : c.id)}
                      >
                        {c.allows_browser ? "Check a page" : "Check a page…"}
                      </button>
                    )}
                  </div>

                  {/* WHAT THE LOOK FOUND, on the card that asked. */}
                  <LookResults
                    card={c}
                    showAll={showAllLooks.has(c.id)}
                    onShowAll={(id) => setShowAllLooks((prev) => new Set(prev).add(id))}
                  />

                  {steering === c.id && (
                    <NotesPanel
                      card={c}
                      notes={notes[c.id] ?? []}
                      receipts={receipts[c.id] ?? []}
                      noteText={noteText}
                      setNoteText={setNoteText}
                      onSend={(id) => void sendNote(id)}
                    />
                  )}

                  {looking === c.id && (
                    <LookForm
                      card={c}
                      busy={busy}
                      objective={lookObjective}
                      setObjective={setLookObjective}
                      url={lookUrl}
                      setUrl={setLookUrl}
                      onSubmit={(id) => void look(id)}
                      onGrantBrowser={(id, allow) => void grantBrowser(id, allow)}
                    />
                  )}
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      {/* What employees have actually been doing. Kept SEPARATE from cards rather than merged:
          a card is work somebody owns over time, a run is a single act that already happened, and
          turning every run into a card would make this page a log. */}
      {runs.length > 0 && (
        <details className="card" data-testid="work-recent-runs">
          <summary>What your employees have been doing</summary>
          <p className="muted small">
            Single acts rather than work anybody carries — these do not become cards, and a page
            that turned them into cards would be a log.
          </p>
          <ul className="card-list small">
            {runs.slice(0, 15).map((r, i) => (
              <li key={i}>
                <strong>{r.employee_name}</strong> · {r.purpose}{" "}
                <span className="muted small">{r.status.toLowerCase()}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {/*
        THE OTHER TWO KINDS, NAMED AND LEFT ALONE.

        The record and the machinery are not on the desk, so the desk has to say where they went and
        say enough about each that she does not have to go and look. "Nothing needs you" about the
        machinery is the whole reason the machinery is not on this screen.
      */}
      <section className="work-region" data-testid="work-elsewhere">
        <div className="work-band-head">
          <h3>Everything else</h3>
          {/* EVERY BAND HEAD SAYS WHAT ITS BAND IS FOR. This one was the exception, and the rank
              spec caught it by finding no note to measure against — which is the Rule-0 guard
              doing its job on a real omission rather than on a fixture. */}
          <p className="work-band-note">The two kinds that are not on this screen, and where they went.</p>
        </div>
        <div className="work-elsewhere-tiles">
          <div className="card work-tile">
            <p className="work-tile-name">The record</p>
            <p className="small">
              Everything the firm has finished, searchable and grouped by month, with identical runs collapsed.
              It is a record, not a to-do, which is why it is not on this screen.
            </p>
            <button type="button" data-testid="work-goto-record" onClick={() => onGoto("record")}>
              Search the record
            </button>
          </div>
          <div className="card work-tile">
            <p className="work-tile-name">The machinery</p>
            <p className="small" data-testid="work-machinery-health">
              {machineryHealth.total === 0
                ? "No scheduled jobs yet."
                : `${machineryHealth.total} job${machineryHealth.total === 1 ? "" : "s"} on a clock · ` +
                  `${machineryHealth.green} green` +
                  (machineryHealth.never > 0 ? ` · ${machineryHealth.never} never run` : "") +
                  (machineryHealth.trouble > 0
                    ? ` · ${machineryHealth.trouble} needs a look`
                    : " · nothing needs you.")}
            </p>
            <button type="button" data-testid="work-goto-machinery" onClick={() => onGoto("machinery")}>
              Check the machinery
            </button>
          </div>
        </div>
      </section>
    </>
  );
}
