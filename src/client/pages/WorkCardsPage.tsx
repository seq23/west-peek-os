import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api, onNewWorkCardRequested, useApi, type MeResponse } from "../lib/api";
import { triage } from "@shared/work/workCards";
import { deskSummary } from "@shared/work/liveStatus";
import { WorkRecordView } from "./WorkRecordView";
import { NewWorkCard } from "./work/NewWorkCard";
import { WorkDesk, deskSections } from "./work/WorkDesk";
import type { WorkCardRow, RecentRun, Assignable } from "./work/types";

/**
 * Work cards — what the firm is actually doing, who owns it, and what happens next.
 *
 * WHAT WAS WRONG, in the operator's words: "I don't understand work cards, and there's no way to
 * create them." Both halves were fair. Cards appear as a CONSEQUENCE of five different things
 * happening elsewhere — a routed capture, an executed Ask, a meeting commitment, a system conflict —
 * the page never said which, and the one route that makes a card directly had no button. So the
 * concept was invisible and the page looked broken.
 *
 * A card is a unit of work somebody owns, with a next action. Those two halves are what separate it
 * from everything nearby: a notification says look at this, an approval says decide this, a card
 * says somebody is doing this and here is what happens next.
 *
 * WHY A SCHEDULED JOB HAS NO CARD, which was the other half of the question. A job is not a task
 * somebody owns — it is machinery that runs on a clock. What a job PRODUCES can become a card, when
 * it produces something a person has to carry.
 *
 * BLOCKED SORTS FIRST. It is the only state where work has stopped and someone must intervene;
 * open and in-progress cards are moving. Sorting by priority or age alone buries the one kind that
 * needs a person.
 *
 * ─── WHY THIS FILE IS NOW A SHELL (22 Sep 2026) ──────────────────────────────────────────────
 *
 * It was 1,588 lines in one function: the masthead, the three tabs, the create form, the bands,
 * the eight block doors, the note thread and the look panel. Four separate pieces of work — a card
 * detail page, a create door, steering from the desk, and refresh — each needed part of it, and
 * they could not be built side by side in one file without colliding on every line.
 *
 * So the page kept what only it can own — the one board fetch, the masthead answer, the three
 * addresses, and moving a card's state (which the record shares) — and everything else moved,
 * verbatim, into `pages/work/`. No testid changed, no route changed, no fetch was added or
 * removed. The pieces are named in `shared/help/pageGuide/work.ts` so `validate:page-guides` reads
 * them all rather than only this file.
 */

/**
 * THE THREE ADDRESSES, and why they are addresses rather than sections.
 *
 * Four kinds of thing were rendering at nearly one weight on one scroll: what needs her, what is
 * happening now, what the firm has done, and what runs on a clock. Two of those are a DESK — she
 * reads them every time she opens the page. The other two are a REFERENCE and a DASHBOARD: she
 * wants them occasionally and specifically.
 *
 * Collapsing the reference material would have kept it in the desk's scroll, which is the actual
 * cost — on the 199 days out of 200 when she is not looking anything up, a collapsed section is
 * still something she scrolls past and something her eye has to rule out. Giving them their own
 * address means the desk is the whole page by default, and the record is a place she goes.
 */
const WORK_VIEWS = ["desk", "record", "machinery"] as const;
type WorkView = (typeof WORK_VIEWS)[number];

export function WorkCardsPage({
  me,
  onChanged,
  onNavigate,
  machinery,
}: {
  me: MeResponse;
  onChanged: () => void;
  onNavigate: (k: string) => void;
  /**
   * The scheduled machinery, handed in by the shell rather than imported, so this page owns where
   * the machinery lives without owning what it is. It renders only on its own tab.
   */
  machinery?: ReactNode;
}) {
  const board = useApi<{
    cards: WorkCardRow[];
    recent_runs: RecentRun[];
    assignable: Assignable;
    /** WAVE C (22 Sep 2026): the moment she last looked at the desk, before this visit marks it. */
    desk_seen_at: string | null;
  }>("/api/work-cards/by-owner");
  const [message, setMessage] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);

  /*
   * THE CREATE DOOR, REACHABLE FROM ANYWHERE (Wave B). The shell's global masthead button and its
   * keyboard shortcut both navigate here and then call `requestNewWorkCard()` — this is the one
   * subscriber, and it opens the same form the page's own "Add a card" toggle always has.
   */
  useEffect(() => onNewWorkCardRequested(() => setAdding(true)), []);

  const all = board.data?.cards ?? [];
  const live = useMemo(() => triage(all), [all]);
  const runs = board.data?.recent_runs ?? [];
  const deskSeenAt = board.data?.desk_seen_at ?? null;

  /*
   * SHE OPENED THE DESK. Marked once the board has actually loaded, and only once per mount — the
   * same "reaching the page is looking at it" shape `App.tsx`'s `POST /api/mp-home/visited` already
   * uses for Home's modules, kept on its own door (migration 0225's comment) so it means "she read
   * the Desk" rather than "a tab somewhere fetched it." Marking again on every `board.reload()`
   * (a card moved, a note sent) would erase "new since you looked" the instant she acts on
   * anything, so the dependency is deliberately just whether the first load landed.
   */
  useEffect(() => {
    if (!board.data) return;
    void api("/api/work-cards/desk-seen", { method: "POST", body: {} });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(board.data)]);

  /** Which of the three addresses is on screen. A reading position, so it is not persisted. */
  const [view, setView] = useState<WorkView>("desk");
  /**
   * Bumped whenever a card changes state, so the record re-reads itself after a Reopen without the
   * whole board being remounted. `board.reload()` cannot do this: the record is a different query.
   */
  const [recordNonce, setRecordNonce] = useState(0);

  /**
   * THE MACHINERY'S HEALTH, read here so the desk can say in one line whether it needs looking at.
   * It is the only thing about the machinery that belongs on the desk: "nothing needs you" is what
   * lets her not open the tab.
   */
  const jobs = useApi<{ jobs: Array<{ job_key: string; name: string; status: string; recent_runs: Array<{ status: string }> }> }>("/api/jobs");
  const machineryHealth = useMemo(() => {
    const list = jobs.data?.jobs ?? [];
    let green = 0;
    let trouble = 0;
    let never = 0;
    for (const j of list) {
      const last = j.recent_runs?.[0] ?? null;
      if (j.status === "PAUSED") trouble += 1;
      else if (!last) never += 1;
      else if (last.status === "SUCCEEDED") green += 1;
      else trouble += 1;
    }
    return { total: list.length, green, trouble, never };
  }, [jobs.data]);

  /*
   * THE TWO SECTIONS, FROM ONE READER (23 Sep 2026). `deskSections` runs every card through
   * `liveStatus` (shared/work/liveStatus.ts); the masthead's sentence below counts those same
   * statuses rather than deciding again for itself.
   */
  const sections = useMemo(() => deskSections(live, me.id, new Date(), deskSeenAt), [live, me.id, deskSeenAt]);

  // DECKS WAITING ON A DECISION ARE WORK WAITING ON YOU. "i dont see any indication of v12 deck
  // anywhere" — it was on Fund strategy, under the proposals, and nowhere on the page called Work.
  const deck = useApi<{ versions?: Array<{ id: string; version_no: number; title: string; state: string; created_by: string; created_at: string; document_id: string | null; change_summary: string | null }> }>("/api/deck");
  const decksWaiting = (deck.data?.versions ?? []).filter((v) => v.state === "PROPOSED");

  async function move(id: string, state: string) {
    const res = await api<{ error?: string; detail?: string }>(`/api/work-cards/${id}`, {
      method: "PATCH",
      body: { state },
    });
    if (res.status !== 200) setMessage(`Could not move it: ${res.data?.detail ?? res.data?.error ?? res.status}`);
    board.reload();
    // The record is a different query over the same rows, so reloading the board does not touch it.
    // Without this, reopening something leaves it showing in the record it has just left.
    setRecordNonce((n) => n + 1);
    onChanged();
  }

  /*
   * THE HEADER IS COUNTED FROM WHAT IS DRAWN. On 23 Sep it said "One thing is stopped until you
   * answer" over a card that was merely unowned — the old count had its own idea of "waiting".
   * `deskSummary` counts the statuses the sections are drawn from, decks included.
   */
  const summary = deskSummary([...sections.needs, ...sections.worked].map((e) => e.status), decksWaiting.length);

  return (
    <section data-testid="work-cards-page" className="work-surface">
      {/*
        RANK 0 IS THE ANSWER, NOT A COUNT.

        This header used to read "2 waiting on you" in an `h3` that measured 18px/700 — the same
        size and weight as both band headings under it, because `.home-section-head h3` and
        `.home-section-head h4` resolve to one rule. Three ranks of meaning, one rank of type. The
        sentence is the fix for the first half; `.work-masthead h2` at --text-2xl over
        `.work-band-head h3` at --text-xl is the fix for the second, and `validate:heading-scale`
        holds both selectors to tags this page actually emits.
      */}
      <header className="work-masthead">
        <div className="work-masthead-said">
          <h2 data-testid="work-answer" className={board.data && summary.clear ? "is-clear" : undefined}>
            {board.data ? summary.line : "Reading the desk…"}
          </h2>
        </div>
        <button type="button" className="btn-strong" data-testid="work-card-add-toggle" onClick={() => setAdding((a) => !a)}>
          {adding ? "Cancel" : "Add a card"}
        </button>
      </header>

      {/*
        THE FOUR KINDS, SEPARATED BY ADDRESS. Desk holds the two she reads every time — what needs
        her and what is happening now. The record and the machinery are places she goes.
      */}
      <div className="work-views" role="tablist" aria-label="Work">
        {WORK_VIEWS.map((v) => (
          <button
            key={v}
            type="button"
            role="tab"
            id={`work-tab-${v}`}
            aria-selected={view === v}
            aria-controls={`work-panel-${v}`}
            className={`work-view-tab${view === v ? " is-on" : ""}`}
            data-testid={`work-view-${v}`}
            onClick={() => setView(v)}
          >
            {/* SHORT ON THE TAB, LONG ON THE BAND HEAD. "The record" and "The machinery" read as
                prose where they name a region; on a 320px tab strip the two definite articles were
                what pushed the third tab off the screen. */}
            {v === "desk" ? "Desk" : v === "record" ? "Record" : "Machinery"}
            {v === "desk" && summary.needsYou > 0 && <span className="work-view-dot" aria-hidden="true" />}
            {v === "machinery" && machineryHealth.total > 0 && (
              <span className="work-view-n">{machineryHealth.total}</span>
            )}
          </button>
        ))}
      </div>

      {message && <p className="notice" data-testid="work-cards-message">{message}</p>}

      {/* THE FORM LIVES WITH ITS BUTTON, not inside a panel — "Add a card" is in the masthead and
          is pressed from any of the three addresses. It is mounted whether or not it is open, so
          what she has typed survives a Cancel exactly as it did when it lived in this function. */}
      <NewWorkCard
        me={me}
        open={adding}
        assignable={board.data?.assignable ?? null}
        busy={busy}
        setBusy={setBusy}
        setMessage={setMessage}
        onCreated={() => { board.reload(); onChanged(); }}
        onClose={() => setAdding(false)}
      />

      {view === "record" && (
        <div role="tabpanel" id="work-panel-record" aria-labelledby="work-tab-record" className="work-panel">
          <WorkRecordView onMove={move} onNavigate={onNavigate} refreshNonce={recordNonce} />
        </div>
      )}

      {view === "machinery" && (
        <div role="tabpanel" id="work-panel-machinery" aria-labelledby="work-tab-machinery" className="work-panel">
          <div className="work-band-head">
            <h3>The machinery</h3>
            <p className="work-band-note">
              Work that runs on a clock whether anyone looks. You read this to check it is healthy, not to do
              anything — and a job is not a card, because a card is work somebody owns and a job is machinery.
              What a job produces can become a card.
            </p>
          </div>
          {machinery}
          {/* WHAT EMPLOYEES HAVE BEEN DOING — single acts, not work anybody carries. Moved off the
              desk on 23 Sep: it is a log of the machinery, and the desk is only what needs her and
              what is being worked. */}
          {runs.length > 0 && (
            <details className="card" data-testid="work-recent-runs">
              <summary>What your employees have been doing</summary>
              <ul className="card-list small">
                {runs.slice(0, 15).map((r, i) => (
                  <li key={i}>
                    <strong>{r.employee_name}</strong> · {r.purpose} <span className="muted small">{r.status.toLowerCase()}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {view === "desk" && (
        <div role="tabpanel" id="work-panel-desk" aria-labelledby="work-tab-desk" className="work-panel">
          <WorkDesk
            me={me}
            sections={sections}
            live={live}
            decksWaiting={decksWaiting}
            assignable={board.data?.assignable ?? null}
            answerIsClear={summary.clear}
            adding={adding}
            busy={busy}
            setBusy={setBusy}
            setMessage={setMessage}
            reload={() => board.reload()}
            onNavigate={onNavigate}
            onMove={(id, state) => void move(id, state)}
            onGoto={(v) => setView(v)}
            machineryHealth={machineryHealth}
            loaded={Boolean(board.data)}
          />
        </div>
      )}
    </section>
  );
}
