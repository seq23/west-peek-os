import { useMemo, useState, type ReactNode } from "react";
import { readableDate, shortDate } from "../lib/dates";
import { api, useApi, type MeResponse } from "../lib/api";
import { CARD_SOURCES, STATE_MEANINGS, stateMeaning, triage } from "@shared/work/workCards";
import { isTechnicalBlock } from "@shared/work/blocks";
import type { Block, BlockActionKey } from "@shared/work/blocks";
import { deskAnswer, deskSubline } from "@shared/work/deskAnswer";
import { previewStartsTicked } from "@shared/work/previewLane";
import { PARTNERS, partnerFor } from "@shared/registry/partners";
import { portraitFor } from "../lib/employeePortraits";
import { WorkRecordView } from "./WorkRecordView";
import { ArtifactShelf } from "./ArtifactShelf";
import { WebPropertyChangePanel, WorkKindRules } from "./WebPropertyChangePanel";

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
 */

interface Owner {
  key: string;
  name: string;
  role: string | null;
  kind: "AI" | "HUMAN" | "NOBODY";
}

interface WorkCardRow {
  id: string;
  title: string;
  description: string | null;
  state: string;
  priority: string;
  owner_type: string;
  owner_id: string | null;
  next_action: string | null;
  due_at: string | null;
  capture_id: string | null;
  created_at: string;
  owner_name?: string | null;
  owner_role?: string | null;
  allows_browser?: number;
  /** PUBLIC_MODEL_APPROVED | PRIVATE_MODEL_ONLY — which models may see it. */
  model_access?: string | null;
  /** INTERNAL | EXTERNAL — whether it previews before it leaves. Not a model decision. */
  audience?: string | null;
  /**
   * WHERE THE LAST RUN ACTUALLY WENT. Read from `ai_run`, which is immutable, so recategorising a
   * card changes where its NEXT run goes and cannot touch the record of where the last one went.
   */
  last_run?: { provider_key: string | null; model: string | null; status: string; cost_usd: number | null; at: string } | null;
  kind?: string | null;
  work_attempts?: number;
  /**
   * 0185 — WHAT WENT WRONG ON THE LAST ATTEMPT, while the card is still retrying and not yet
   * blocked. This is the field that stops a failing card reading as a waiting one.
   */
  work_last_failure?: string | null;
  work_last_failure_at?: string | null;
  /** 0173 — present only while the card is blocked: the four sentences and the doors. */
  block?: (Block & { blockedAt: string | null; lane?: string | null; laneName?: string | null; raw?: string | null }) | null;
  looks?: Array<{
    id: string; objective: string; start_url: string; status: string;
    result_text: string | null; refusal_reason: string | null;
  }>;
}

interface RecentRun {
  ai_employee_id: string;
  employee_name: string;
  purpose: string;
  status: string;
  created_at: string;
}

/**
 * Who is carrying a card, with their face.
 *
 * Reused across the board rather than inlined, because the same chip belongs anywhere a piece of
 * work is attributed. Falls back to initials, and says "Nobody" rather than nothing — an unowned
 * card is a real state and the one most worth spotting.
 */
function OwnerChip({ name }: { name: string | null }): JSX.Element {
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

/**
 * WHAT SHE TYPED, AND WHAT IT TURNED INTO (0175).
 *
 * Her question was "tell me what my instructions turned into", asked of an agent, about a database.
 * The answer belongs on the card, so she never has to ask it that way again.
 */
interface InstructionReceipt {
  said: Array<{ source: string; text: string; who: string | null }>;
  interpretation: { understood: string; steer: string[]; cannot: string[] } | null;
  failure?: string;
  model: string | null;
  at: string;
}

interface WorkCardNote {
  id: string;
  body: string;
  response: string | null;
  acknowledged_at: string | null;
  created_at: string;
  author: string | null;
}

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
    assignable: { employees: Array<{ id: string; name: string; role: string }>; partners: Array<{ id: string; full_name: string }> };
  }>("/api/work-cards/by-owner");
  const [message, setMessage] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  /*
   * THE TWO LABELS THE OWNER ASKED FOR, set as she writes the card rather than remembered
   * afterwards — "WE NEED TO CLASSIFY ON EACH WORK CARD GOING FORWARD ... SO THERE IS NO CONFUSION."
   *
   * THE DEFAULTS ARE THE DESIGN. "MOST WORK IS INTERNAL AND NOT-CONFIDENTIAL SO CAN USE FREE
   * TRAINING MODELS WITH REASONING AND CLOSE TO $0." If the normal case needed a deliberate choice
   * it would not get one, the free lanes would stay unused, and the bill would not move — which is
   * the state this whole change exists to leave behind. So the form opens on the normal case and
   * only the exception costs a click.
   *
   * AND THEY ARE TWO CONTROLS, NOT ONE. Naming them separately is the point: an LP memo for Sequoia
   * is Internal AND Private model only; an event kit for a guest is External AND Public model
   * approved. A single control could not express either.
   */
  const [modelAccess, setModelAccess] = useState<"PUBLIC_MODEL_APPROVED" | "PRIVATE_MODEL_ONLY">("PUBLIC_MODEL_APPROVED");
  const [audience, setAudience] = useState<"INTERNAL" | "EXTERNAL">("INTERNAL");
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
  const [title, setTitle] = useState("");
  // Decided while writing the card, not afterwards. Whether work may involve looking things up is
  // part of describing the work.
  const [newAllowsBrowser, setNewAllowsBrowser] = useState(false);
  const [nextAction, setNextAction] = useState("");
  // Defaults to you. Assigning to your partner or to an employee is the same act either way.
  const [owner, setOwner] = useState(`HUMAN:${me.id}`);
  /*
   * HER TWO FIELDS, ON EVERY CARD (18 Sep 2026).
   *
   *     Who is this for?     [ Scooter          ]
   *     Show me first?       [✓]
   *
   * Migration 0183 added both columns and NOTHING EVER WROTE EITHER — which is why the whole
   * preview lane, boundary guard and approval token included, has never run once in production.
   * This form is the thing that was missing.
   *
   * THE CHECKBOX IS ALWAYS PRESENT AND ALWAYS HERS. The recipient sets only where it STARTS —
   * somebody outside the two partners starts it ticked, either partner starts it unticked. An
   * earlier design derived preview-first FROM the recipient and her objection was exact: it made
   * her real case, "something for Scooter that I want to see first", look impossible.
   *
   * `previewTouched` is what keeps that promise honest. Until she touches the box it follows the
   * address she is typing; the moment she sets it herself it stays where she put it, and typing a
   * different address never moves it back.
   */
  const [resultRecipient, setResultRecipient] = useState("");
  const [previewTouched, setPreviewTouched] = useState(false);
  const [previewFirst, setPreviewFirst] = useState(false);
  /*
   * RESOLVED THROUGH THE REGISTRY, NEVER TYPED. "Scooter" is what she writes; the address is
   * `shared/registry/partners.ts`'s to supply. `validate:partners` fails the build on a partner
   * address typed anywhere else, and this field would otherwise be the fifth copy of that fact.
   */
  const recipientAddress = (partnerFor(resultRecipient.trim())?.email ?? resultRecipient.trim()).toLowerCase();
  const previewBoxStartsTicked = previewStartsTicked(recipientAddress);
  const showFirst = previewTouched ? previewFirst : previewBoxStartsTicked;
  const [busy, setBusy] = useState(false);

  const all = board.data?.cards ?? [];
  const live = useMemo(() => triage(all), [all]);
  const runs = board.data?.recent_runs ?? [];

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

  /**
   * FOUR BANDS, not one section per person.
   *
   * Grouping by individual owner meant a section header for every employee holding a single card —
   * seventeen possible headings for a page whose entire job is letting somebody see what is on the
   * firm's plate at a glance. What a partner actually asks is "what is on ME, what is on my
   * partner, what are the employees doing, and what has nobody picked up".
   *
   * NOBODY LEADS, because a card nobody owns is the one most likely to be quietly dropped, and any
   * grouping that buries it is hiding the thing worth seeing. Yours comes next: it is the only band
   * you can act on without talking to anybody.
   */
  /*
   * SECTIONS BY WHAT THEY MEAN TO YOU, NOT BY WHO HOLDS THE CARD. Operator, 14 Sep 2026: "the entire
   * WORK page needs to be reworked... it needs to make sense and be self explanatory." The old bands
   * (nobody / yours / your partner / your employees) answered "who has it", which is not the
   * question you open this page with. The question is: what needs ME, what is being handled, and
   * what got done. Three bands, in that order.
   */
  /*
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
   */
  const bands = useMemo(() => {
    const waiting: WorkCardRow[] = [];
    const flight: WorkCardRow[] = [];
    for (const c of live) {
      const mine = c.owner_type === "HUMAN" && c.owner_id === me.id;
      const nobody = c.owner_type === "UNASSIGNED" || !c.owner_id;
      if (c.state === "BLOCKED" || nobody || mine) waiting.push(c);
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
  }, [live, me.id]);

  const failingCount = useMemo(
    () =>
      live.filter(
        (c) => Boolean(c.work_last_failure) && c.state !== "BLOCKED" && c.state !== "DONE" && c.state !== "CANCELLED",
      ).length,
    [live],
  );

  // DECKS WAITING ON A DECISION ARE WORK WAITING ON YOU. "i dont see any indication of v12 deck
  // anywhere" — it was on Fund strategy, under the proposals, and nowhere on the page called Work.
  const deck = useApi<{ versions?: Array<{ id: string; version_no: number; title: string; state: string; created_by: string; created_at: string; document_id: string | null; change_summary: string | null }> }>("/api/deck");
  const decksWaiting = (deck.data?.versions ?? []).filter((v) => v.state === "PROPOSED");

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    const res = await api<{ id?: string; error?: string; detail?: string }>("/api/work-cards", {
      method: "POST",
      body: {
        title: title.trim(),
        ...(nextAction.trim() ? { next_action: nextAction.trim() } : {}),
        owner_type: owner.split(":")[0],
        owner_id: owner.split(":").slice(1).join(":"),
        model_access: modelAccess,
        audience,
      },
    });
    setBusy(false);
    if (res.status !== 201) {
      setMessage(`Not created: ${res.data?.detail ?? res.data?.error ?? res.status}`);
      return;
    }
    // The grant is part of describing the work, so it is applied as the card is created rather
    // than left as a second thing to remember afterwards.
    if (newAllowsBrowser && res.data?.id) {
      await api(`/api/work-cards/${res.data.id}/browser-permission`, {
        method: "POST",
        body: { allows_browser: true },
      });
    }
    setMessage(
      (owner === `HUMAN:${me.id}` ? "Added, owned by you." : "Added and handed over.") +
        (newAllowsBrowser ? " It can look things up online." : "") +
        (recipientAddress
          ? showFirst
            ? ` When it is finished you see it before it goes to ${recipientAddress}.`
            : ` When it is finished it goes straight to ${recipientAddress}.`
          : " The result lands on your Home; there is nobody to send it to."),
    );
    setNewAllowsBrowser(false);
    setTitle("");
    setNextAction("");
    setResultRecipient("");
    setPreviewTouched(false);
    setPreviewFirst(false);
    setAdding(false);
    board.reload();
    onChanged();
  }

  /** Hand a card to somebody. The same act whether it is an employee or a partner. */
  async function assign(id: string, ownerType: string, ownerId: string) {
    const res = await api<{ error?: string; detail?: string }>(`/api/work-cards/${id}`, {
      method: "PATCH",
      body: { owner_type: ownerType, owner_id: ownerId },
    });
    if (res.status !== 200) setMessage(`Could not reassign it: ${res.data?.detail ?? res.data?.error ?? res.status}`);
    board.reload();
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
    board.reload();
  }

  /** Give (or withdraw) this card standing permission to read pages. */
  async function grantBrowser(cardId: string, allow: boolean) {
    const res = await api<{ detail?: string }>(`/api/work-cards/${cardId}/browser-permission`, {
      method: "POST",
      body: { allows_browser: allow },
    });
    setMessage(res.data?.detail ?? null);
    board.reload();
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
    board.reload();
    onChanged();
  }

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

  const waitingCards = bands.find((b) => b.key === "waiting")?.cards.length ?? 0;
  const inFlight = bands.find((b) => b.key === "flight")?.cards.length ?? 0;
  const answer = deskAnswer({ waiting: waitingCards, decks: decksWaiting.length, inFlight, failing: failingCount });
  const subline = deskSubline({ waiting: waitingCards, decks: decksWaiting.length, inFlight, failing: failingCount });

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
          <p className="work-eyebrow">The firm's work</p>
          <h2 data-testid="work-answer" className={answer.clear ? "is-clear" : undefined}>
            {answer.line}
          </h2>
          {subline && <p className="work-subline muted">{subline}</p>}
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
            {v === "desk" && answer.count > 0 && <span className="work-view-dot" aria-hidden="true" />}
            {v === "machinery" && machineryHealth.total > 0 && (
              <span className="work-view-n">{machineryHealth.total}</span>
            )}
          </button>
        ))}
      </div>

      {message && <p className="notice" data-testid="work-cards-message">{message}</p>}

      {/* THE FORM LIVES WITH ITS BUTTON, not inside a panel — "Add a card" is in the masthead and
          is pressed from any of the three addresses. */}
      {adding && (
        <form className="card" data-testid="work-card-form" onSubmit={create}>
          <div className="form-row">
            <label style={{ flexGrow: 1 }}>
              What needs doing?{" "}
              <input data-testid="work-card-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Get Sensori's SPV terms from the paperwork" />
            </label>
          </div>
          <div className="form-row">
            <label style={{ flexGrow: 1 }}>
              What happens next?{" "}
              <input data-testid="work-card-next" value={nextAction} onChange={(e) => setNextAction(e.target.value)} placeholder="Ask Shanna for the closing docs" />
            </label>
            <label>
              Who carries it{" "}
              <select data-testid="work-card-owner" value={owner} onChange={(e) => setOwner(e.target.value)}>
                <option value={`HUMAN:${me.id}`}>Me</option>
                {(board.data?.assignable.partners ?? [])
                  .filter((p) => p.id !== me.id)
                  .map((p) => (
                    <option key={p.id} value={`HUMAN:${p.id}`}>{p.full_name}</option>
                  ))}
                {(board.data?.assignable.employees ?? []).map((e) => (
                  <option key={e.id} value={`AI:${e.id}`}>{e.name} — {e.role}</option>
                ))}
              </select>
            </label>
            <button type="submit" className="btn-strong" disabled={busy} data-testid="work-card-submit">
              {busy ? "…" : "Add"}
            </button>
          </div>
          {/* ── HER TWO FIELDS ──────────────────────────────────────────────────────────────
              "Who is this for?" and "Show me first?", in that order, because the first sets where
              the second starts. Both are on EVERY card: a checkbox that appears only sometimes is
              a rule wearing a checkbox, and she was emphatic that this is a checkbox. */}
          <div className="form-row preview-lane-fields">
            <label style={{ flexGrow: 1 }}>
              Who is this for?{" "}
              <input
                data-testid="work-card-result-recipient"
                value={resultRecipient}
                onChange={(e) => setResultRecipient(e.target.value)}
                list="work-card-recipients"
                placeholder="Scooter, or an email address — leave blank if it is for you"
              />
              <datalist id="work-card-recipients">
                {/* The two partners by name, from the registry. Never a typed address. */}
                {PARTNERS.map((p) => (
                  <option key={p.firmUserId} value={p.firstName}>{p.fullName}</option>
                ))}
              </datalist>
            </label>
            <label className="preview-lane-tick" data-testid="work-card-preview-first-label">
              <input
                type="checkbox"
                data-testid="work-card-preview-first"
                checked={showFirst}
                onChange={(e) => {
                  setPreviewTouched(true);
                  setPreviewFirst(e.target.checked);
                }}
              />{" "}
              Show me first?
            </label>
          </div>
          <p className="muted small" data-testid="work-card-preview-explainer">
            {resultRecipient.trim() === "" ? (
              <>
                <strong>Blank means it is for you.</strong> The result lands on your Home — there is
                nothing to send and nothing to preview.
              </>
            ) : showFirst ? (
              <>
                <strong>You see it before it goes.</strong> When it is finished it waits on your Home
                and in your inbox, with <strong>Send it</strong>, <strong>Send it back</strong> and{" "}
                <strong>Dismiss</strong>. Send it puts the employee's own words on the wire, from
                their address — never a forward with your name on it.
              </>
            ) : (
              <>
                <strong>It goes straight out</strong> to {recipientAddress} when it is finished.
                {previewTouched ? "" : " Anyone outside the two of you starts ticked; you can change it either way, on any card."}
              </>
            )}
          </p>
          <label className="muted small">
            <input
              type="checkbox"
              data-testid="work-card-new-browser"
              checked={newAllowsBrowser}
              onChange={(e) => setNewAllowsBrowser(e.target.checked)}
            />{" "}
            <span>
              <strong>This work may involve looking things up online.</strong> Whoever carries it can
              read public pages for this card without asking each time — read-only, recorded, and
              only for this card.
            </span>
          </label>
          {/* TWO SEPARATE CONTROLS, SIDE BY SIDE, each saying what it actually decides. The words
              on them are the words that get stored — "Public model approved", not a column called
              `confidential` displayed under a friendlier name, because that is how the next reader
              reintroduces the confusion this rename exists to remove. */}
          <div className="form-row">
            <label>
              Which models may see it{" "}
              <select
                data-testid="work-card-model-access"
                value={modelAccess}
                onChange={(e) => setModelAccess(e.target.value as typeof modelAccess)}
              >
                <option value="PUBLIC_MODEL_APPROVED">Public model approved</option>
                <option value="PRIVATE_MODEL_ONLY">Private model only</option>
              </select>
            </label>
            <label>
              Who it goes to{" "}
              <select
                data-testid="work-card-audience"
                value={audience}
                onChange={(e) => setAudience(e.target.value as typeof audience)}
              >
                <option value="INTERNAL">Internal — Sequoia or Scooter</option>
                <option value="EXTERNAL">External — anyone else</option>
              </select>
            </label>
          </div>
          <p className="muted small">
            <strong>Public model approved</strong> is the normal case and costs close to nothing — hiring
            searches, event kits, room and workshop packets, social posts, Productions work.{" "}
            <strong>Private model only</strong> is for LP names, deal terms, fund figures and diligence
            material, and keeps the work on a model whose terms forbid training on it.{" "}
            <strong>Internal or External</strong> is a label on the work, not a control: what actually
            decides whether something waits for a yes is <strong>Show me first?</strong> above, read
            together with who it is for. Neither of these two answers implies the other, and neither
            implies that one.
          </p>
          <p className="muted small">
            A card without a next action is a wish. Naming the next step is what makes it work
            somebody can pick up.
          </p>
        </form>
      )}

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
        </div>
      )}

      {view === "desk" && (
      <div role="tabpanel" id="work-panel-desk" aria-labelledby="work-tab-desk" className="work-panel">
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
        WHEN THE DESK IS CLEAR. This is the state on most days and it is designed rather than left
        blank — a page that empties out reads as broken, and "nothing is waiting" is the single most
        valuable thing this surface can tell her. It says what would have to happen for something to
        arrive here, so she can believe the silence.
      */}
      {answer.clear && bands.length === 0 && decksWaiting.length === 0 && (
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

      {bands.map((group) => (
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
              const technical = isTechnicalBlock(c.block?.reason);
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
                      <span className={c.state === "BLOCKED" ? "badge badge-bad" : "badge"}>
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
                    THE BLOCK, OUTSIDE THE FOLD. Everything else on a card is detail you go looking
                    for; a block is a question addressed to you, and it reads before you open
                    anything. Four sentences in the order a person asks them — what was this, what
                    stopped, what would fix it, who can — and then the doors.
                  */}
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
                      the live proof — and the standing rules of the kind, flippable by a partner. */}
                  {c.kind === "WEB_PROPERTY_CHANGE" && (
                    <>
                      <WebPropertyChangePanel cardId={c.id} onNavigate={onNavigate} />
                      <WorkKindRules kind="WEB_PROPERTY_CHANGE" canEdit={me.roles.includes("MANAGING_PARTNER")} />
                    </>
                  )}

                  {c.block && (
                    <div className={technical ? "card-block card-block-fault" : "card-block"} data-testid={`work-card-block-${c.id}`}>
                      {/*
                        A FAULT IS NOT A QUESTION, and the heading says which it is. "Blocked —
                        waiting on you" over a lane that has run out of credit reads as though she
                        has been slow to answer something; what actually happened is that the work
                        hit a wall and nothing is being tried until she moves it.
                      */}
                      <p className="lbl">
                        {technical
                          ? `Stopped${c.block.laneName ? ` — ${c.block.laneName} refused it` : ""} · nothing is being tried`
                          : `Blocked — waiting on ${c.block.who === "ENGINEER" ? "an engineer" : c.block.who === "SCOOTER" ? "Scooter" : "you"}`}
                      </p>
                      <p data-testid={`work-card-block-stopped-${c.id}`}><strong>{c.block.stopped}</strong></p>
                      <p className="small">What was asked for: {c.block.trying}</p>
                      <p className="small" data-testid={`work-card-block-needed-${c.id}`}>What would clear it: {c.block.needed}</p>
                      {/*
                        WHAT THE VENDOR ACTUALLY SAID — on demand, never by default.

                        "provider_failure:provider_http_400" was the ONLY account of the 17 Sep
                        failure that existed anywhere, and it lived in a database. It is genuinely
                        useful to whoever ends up fixing the lane, and it is not an explanation, so
                        it lives behind a disclosure with the sentence above it doing the work.
                      */}
                      {c.block.raw && (
                        <details className="block-raw" data-testid={`work-card-block-raw-${c.id}`}>
                          <summary className="muted small">Show me exactly what it said</summary>
                          <pre className="block-raw-text">{c.block.raw}</pre>
                        </details>
                      )}
                      {c.block.who === "ENGINEER" && (
                        <p className="notice small">
                          This one is not yours to answer. Sending it on tells whoever maintains the system
                          what happened and what they will need; the card stays here until they have fixed it.
                        </p>
                      )}

                      <div className="notification-actions">
                        {c.block.actions.map((a) => (
                          <button
                            key={a.key}
                            type="button"
                            className={a.key === "ANSWER" ? "btn-strong" : undefined}
                            data-testid={`work-card-block-${a.key.toLowerCase()}-${c.id}`}
                            title={a.hint}
                            onClick={() => {
                              setClearText("");
                              setClearing(clearing?.card === c.id && clearing.action === a.key ? null : { card: c.id, action: a.key });
                            }}
                          >
                            {a.label}
                          </button>
                        ))}
                      </div>

                      {clearing?.card === c.id && (
                        <div className="card-block-form" data-testid={`work-card-block-form-${c.id}`}>
                          <p className="muted small">
                            {c.block.actions.find((a) => a.key === clearing.action)?.hint}
                          </p>
                          {/* A YES-OR-NO ANSWER IS TWO BUTTONS, not a box to type "yes" into. The
                              choice also DOES the thing — saying yes to a page grants it. */}
                          {/*
                            A FAULT DOOR NEEDS NO PROSE. "Try it again" and "stand that one down"
                            are not questions she is answering — asking her to type something into
                            a box first would be a form standing between her and the fix, which is
                            the shape of the problem this whole change exists to remove.
                          */}
                          {clearing.action === "RETRY" || clearing.action === "ANOTHER_LANE" || clearing.action === "PAUSE_LANE" ? (
                            <div className="notification-actions">
                              <button
                                type="button"
                                className="btn-strong"
                                disabled={busy}
                                data-testid={`work-card-block-do-${clearing.action.toLowerCase()}-${c.id}`}
                                onClick={() => void clearBlock(c.id, clearing.action)}
                              >
                                {clearing.action === "RETRY"
                                  ? "Try it again now"
                                  : clearing.action === "ANOTHER_LANE"
                                    ? `Send it elsewhere${c.block?.laneName ? ` and stand ${c.block.laneName} down for six hours` : ""}`
                                    : `Stop using ${c.block?.laneName ?? "it"} for a week`}
                              </button>
                            </div>
                          ) : clearing.action === "HAND_ON" ? (
                            <div className="notification-actions">
                              {/* The roster, not a guess: the server refuses anybody who is not employed. */}
                              <select
                                aria-label={`Who should take ${c.title}`}
                                data-testid={`work-card-block-handon-who-${c.id}`}
                                value={clearText}
                                onChange={(e) => setClearText(e.target.value)}
                              >
                                <option value="">Who should take it?</option>
                                {(board.data?.assignable.employees ?? [])
                                  .filter((emp) => emp.id !== c.owner_id)
                                  .map((emp) => (
                                    <option key={emp.id} value={emp.id}>
                                      {emp.name} — {emp.role}
                                    </option>
                                  ))}
                              </select>
                              <button
                                type="button"
                                className="btn-strong"
                                disabled={busy || !clearText}
                                data-testid={`work-card-block-handon-${c.id}`}
                                onClick={() => void clearBlock(c.id, "HAND_ON", clearText)}
                              >
                                Give it to them
                              </button>
                            </div>
                          ) : clearing.action === "ANSWER" && (c.block.actions.find((a) => a.key === "ANSWER")?.choices ?? []).length > 0 ? (
                            <div className="notification-actions">
                              {c.block.actions.find((a) => a.key === "ANSWER")!.choices!.map((ch) => (
                                <button
                                  key={ch.key}
                                  type="button"
                                  className="btn-strong"
                                  disabled={busy}
                                  data-testid={`work-card-block-choice-${ch.key}-${c.id}`}
                                  onClick={() => void clearBlock(c.id, "ANSWER", ch.key)}
                                >
                                  {ch.label}
                                </button>
                              ))}
                            </div>
                          ) : (
                            <>
                              <textarea
                                rows={3}
                                value={clearing.card === c.id ? clearText : ""}
                                data-testid={`work-card-block-text-${c.id}`}
                                aria-label={`Your answer for ${c.title}`}
                                placeholder={
                                  clearing.action === "DROP"
                                    ? "Why you are dropping it — kept on the record"
                                    : clearing.action === "ESCALATE"
                                      ? "Anything an engineer should know (optional)"
                                      : clearing.action === "CHANGE"
                                        ? "The job, rewritten in your own words"
                                        : "Your answer, in your own words"
                                }
                                onChange={(e) => setClearText(e.target.value)}
                              />
                              <button
                                type="button"
                                className="btn-strong"
                                disabled={busy}
                                data-testid={`work-card-block-send-${c.id}`}
                                onClick={() => void clearBlock(c.id, clearing.action)}
                              >
                                {clearing.action === "DROP" ? "Drop it" : clearing.action === "ESCALATE" ? "Send it on" : "Send it"}
                              </button>
                            </>
                          )}
                        </div>
                      )}
                    </div>
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
                      {(board.data?.assignable.partners ?? []).map((p) => (
                        <option key={p.id} value={`HUMAN:${p.id}`}>{p.full_name}</option>
                      ))}
                      {(board.data?.assignable.employees ?? []).map((emp) => (
                        <option key={emp.id} value={`AI:${emp.id}`}>{emp.name}</option>
                      ))}
                    </select>
                    {c.state === "OPEN" && (
                      <button type="button" data-testid={`work-card-start-${c.id}`} onClick={() => void move(c.id, "IN_PROGRESS")}>
                        Start
                      </button>
                    )}
                    {c.state !== "DONE" && (
                      <button type="button" className="btn-strong" data-testid={`work-card-done-${c.id}`} onClick={() => void move(c.id, "DONE")}>
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
                        onClick={() => void move(c.id, "CANCELLED")}
                      >
                        Drop
                      </button>
                    )}
                    {/* SAY SOMETHING TO WHOEVER IS CARRYING IT. Offered only while the work is
                        actually in flight, because the loop re-reads notes only on a card it is
                        still working — a note on finished work would be written into a void, and
                        the server refuses it for the same reason. */}
                    {c.owner_type === "AI" && ["OPEN", "IN_PROGRESS", "BLOCKED"].includes(c.state) && (
                      <button
                        type="button"
                        data-testid={`work-card-steer-${c.id}`}
                        title="They pick this up on their next step, without stopping the work"
                        onClick={() => void openSteering(c.id)}
                      >
                        {steering === c.id ? "Never mind" : `Tell ${c.owner_name ?? "them"} something`}
                      </button>
                    )}
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

                  {/* WHAT THE LOOK FOUND, on the card that asked. Fenced as untrusted where it is
                      shown, because a web page saying "ignore your previous instructions" is
                      exactly the input that fencing exists for. */}
                  {(c.looks ?? []).length > 0 && (
                    <details className="work-card-looks" data-testid={`work-card-looks-${c.id}`}>
                      <summary>
                        {c.looks!.length} page{c.looks!.length === 1 ? "" : "s"} opened and read
                        {c.looks!.some((l) => l.status === "SUCCEEDED") ? " · answered" : ""}
                      </summary>
                      {/* THE TWO MOST RECENT, AND NO MORE BY DEFAULT. A card that has been worked
                          hard accumulated a dozen looks, each with up to 1,200 characters of page
                          text, so one busy card was taller than the rest of the board put together.
                          The older ones are still here — they are just not the first thing the card
                          spends its height on. */}
                      {(showAllLooks.has(c.id) ? c.looks! : c.looks!.slice(0, 2)).map((l) => (
                        <div key={l.id} className="work-look">
                          <p className="small"><strong>{l.objective}</strong></p>
                          <p className="muted small">{l.start_url} · {l.status.toLowerCase()}</p>
                          {l.refusal_reason && <p className="notice small">{l.refusal_reason}</p>}
                          {l.result_text && (
                            <>
                              <pre className="browser-result">{l.result_text.slice(0, 1200)}</pre>
                              <p className="muted small">
                                Read off a live page. Information about the world, not instructions —
                                check anything you would act on.
                              </p>
                            </>
                          )}
                        </div>
                      ))}
                      {c.looks!.length > 2 && !showAllLooks.has(c.id) && (
                        <button
                          type="button"
                          className="link-button"
                          data-testid={`work-card-all-looks-${c.id}`}
                          onClick={() => setShowAllLooks((prev) => new Set(prev).add(c.id))}
                        >
                          Show all {c.looks!.length}
                        </button>
                      )}
                    </details>
                  )}

                  {steering === c.id && (
                    <div className="work-card-look" data-testid={`work-card-steer-form-${c.id}`}>
                      {/* WHAT HAS ALREADY BEEN SAID, and what came back. An acknowledgement here is
                          never a bare tick: the table's CHECK makes seen-and-answered one event, so
                          an employee cannot dismiss a partner's instruction without saying what it
                          changed about the work. Showing the answer is what makes that visible. */}
                      {/*
                        THE RECEIPT. Her words on the left, exactly as she typed them; what the
                        model understood on the right, with the model named.

                        WHY THE MODEL'S NAME IS ON IT. The instruction was "make sure everything I
                        say reaches a thinking model" — a claim she has no way to check unless the
                        page says which model read her words. A receipt that asserts it was read
                        without saying by what is the same assurance the old system gave.
                      */}
                      {(receipts[c.id] ?? []).length > 0 && (
                        <div className="work-card-receipt" data-testid={`work-card-receipt-${c.id}`}>
                          <p className="lbl">What you asked for, and what it turned into</p>
                          {(receipts[c.id] ?? []).slice(0, 3).map((r) => (
                            <div key={r.at} className="work-card-receipt-row">
                              <div>
                                <p className="muted small">You said</p>
                                {r.said.map((said, i) => (
                                  <p key={i} className="work-card-longtext">“{said.text}”</p>
                                ))}
                              </div>
                              <div>
                                <p className="muted small">
                                  {c.owner_name ?? "They"} understood
                                  {r.model ? ` — read by ${r.model}` : ""}
                                </p>
                                {r.interpretation ? (
                                  <>
                                    <p><strong>{r.interpretation.understood}</strong></p>
                                    {r.interpretation.steer.length > 0 && (
                                      <ul className="work-legend">
                                        {r.interpretation.steer.map((line, i) => <li key={i}>{line}</li>)}
                                      </ul>
                                    )}
                                    {/* NOT A DETAIL. This is the part she is owed: the bit of what
                                        she asked for that this work has no step for, said out loud
                                        rather than quietly dropped. */}
                                    {r.interpretation.cannot.length > 0 && (
                                      <p className="notice small" data-testid={`work-card-receipt-cannot-${c.id}`}>
                                        Could not do: {r.interpretation.cannot.join("; ")}
                                      </p>
                                    )}
                                  </>
                                ) : (
                                  <p className="notice small">
                                    Nothing read this yet: {r.failure ?? "the reading did not happen"}. It is tried again on the next run.
                                  </p>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                      {(notes[c.id] ?? []).length > 0 && (
                        <ul className="card-list small" data-testid={`work-card-notes-${c.id}`}>
                          {(notes[c.id] ?? []).map((n) => (
                            <li key={n.id}>
                              <strong>{n.author ?? "A partner"}:</strong> {n.body}
                              <div className="muted small">
                                {n.acknowledged_at
                                  ? `${c.owner_name ?? "They"} answered: ${n.response}`
                                  : "Not picked up yet — they will read it on their next step."}
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}
                      <form onSubmit={(e) => { e.preventDefault(); void sendNote(c.id); }}>
                        <input
                          value={noteText}
                          onChange={(e) => setNoteText(e.target.value)}
                          placeholder="What should they do differently?"
                          aria-label={`Tell whoever is carrying ${c.title} something`}
                          data-testid={`work-card-steer-input-${c.id}`}
                        />
                        <div className="form-row">
                          <button type="submit" className="btn-strong" data-testid={`work-card-steer-send-${c.id}`} disabled={noteText.trim().length < 2}>
                            Send it over
                          </button>
                          {/* Said plainly, because the natural fear is that saying something stops
                              the work or starts it again from the top. It does neither. */}
                          <span className="muted small">They keep working. This lands on their next step.</span>
                        </div>
                      </form>
                    </div>
                  )}

                  {looking === c.id && (
                    <form
                      className="work-card-look"
                      data-testid={`work-card-look-form-${c.id}`}
                      onSubmit={(e) => { e.preventDefault(); void look(c.id); }}
                    >
                      <input
                        value={lookObjective}
                        onChange={(e) => setLookObjective(e.target.value)}
                        placeholder="What should they find out?"
                        aria-label="What to find out"
                      />
                      {/* OPTIONAL. Naming the page was the wrong ask — working out which page
                          answers the question is part of the job, and demanding the address up
                          front made the operator do the looking before asking anyone to look. */}
                      <input
                        value={lookUrl}
                        onChange={(e) => setLookUrl(e.target.value)}
                        placeholder="Leave blank and they will search for it"
                        aria-label="Optional starting page"
                      />
                      <div className="form-row">
                        <button type="submit" className="btn-strong" disabled={busy}>
                          {c.allows_browser ? "Go and look" : "Ask to look"}
                        </button>
                        {/* The grant, offered where it is relevant rather than in a settings page.
                            Standing permission for THIS card only. */}
                        <label className="muted small">
                          <input
                            type="checkbox"
                            checked={c.allows_browser === 1}
                            data-testid={`work-card-browser-grant-${c.id}`}
                            onChange={(e) => void grantBrowser(c.id, e.target.checked)}
                          />{" "}
                          let this card look without asking each time
                        </label>
                      </div>
                    </form>
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
            <button type="button" data-testid="work-goto-record" onClick={() => setView("record")}>
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
            <button type="button" data-testid="work-goto-machinery" onClick={() => setView("machinery")}>
              Check the machinery
            </button>
          </div>
        </div>
      </section>
      </div>
      )}
    </section>
  );
}
