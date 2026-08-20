import { useMemo, useState } from "react";
import { api, useApi, type MeResponse } from "../lib/api";
import { CARD_SOURCES, STATE_MEANINGS, stateMeaning, triage } from "@shared/work/workCards";
import { portraitFor } from "../lib/employeePortraits";

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

export function WorkCardsPage({ me, onChanged, onNavigate }: { me: MeResponse; onChanged: () => void; onNavigate: (k: string) => void }) {
  const board = useApi<{
    cards: WorkCardRow[];
    recent_runs: RecentRun[];
    assignable: { employees: Array<{ id: string; name: string; role: string }>; partners: Array<{ id: string; full_name: string }> };
  }>("/api/work-cards/by-owner");
  const [message, setMessage] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [looking, setLooking] = useState<string | null>(null);
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
  const [lookObjective, setLookObjective] = useState("");
  const [lookUrl, setLookUrl] = useState("");
  const [title, setTitle] = useState("");
  // Decided while writing the card, not afterwards. Whether work may involve looking things up is
  // part of describing the work.
  const [newAllowsBrowser, setNewAllowsBrowser] = useState(false);
  const [nextAction, setNextAction] = useState("");
  // Defaults to you. Assigning to your partner or to an employee is the same act either way.
  const [owner, setOwner] = useState(`HUMAN:${me.id}`);
  const [busy, setBusy] = useState(false);

  const all = board.data?.cards ?? [];
  const live = useMemo(() => triage(all), [all]);
  const finished = all.filter((c) => c.state === "DONE" || c.state === "CANCELLED");
  const runs = board.data?.recent_runs ?? [];

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
  const bands = useMemo(() => {
    const nobody: WorkCardRow[] = [];
    const mine: WorkCardRow[] = [];
    const partner: WorkCardRow[] = [];
    const employees: WorkCardRow[] = [];

    for (const c of live) {
      if (c.owner_type === "UNASSIGNED" || !c.owner_id) nobody.push(c);
      else if (c.owner_type === "AI") employees.push(c);
      else if (c.owner_id === me.id) mine.push(c);
      else partner.push(c);
    }

    const partnerName = partner[0]?.owner_name ?? "Your partner";
    return [
      { key: "nobody", name: "Nobody has picked these up", note: "the ones most likely to be dropped", cards: nobody },
      { key: "mine", name: "Yours", note: me.fullName, cards: mine },
      { key: "partner", name: partnerName, note: "your partner", cards: partner },
      { key: "employees", name: "Your employees", note: `${new Set(employees.map((c) => c.owner_id)).size} carrying work`, cards: employees },
    ].filter((b) => b.cards.length > 0);
  }, [live, me.id, me.fullName]);

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
        (newAllowsBrowser ? " It can look things up online." : ""),
    );
    setNewAllowsBrowser(false);
    setTitle("");
    setNextAction("");
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

  async function move(id: string, state: string) {
    const res = await api<{ error?: string; detail?: string }>(`/api/work-cards/${id}`, {
      method: "PATCH",
      body: { state },
    });
    if (res.status !== 200) setMessage(`Could not move it: ${res.data?.detail ?? res.data?.error ?? res.status}`);
    board.reload();
    onChanged();
  }

  return (
    <section data-testid="work-cards-page">
      <div className="home-section-head">
        <h2>{live.length === 0 ? "Nothing open" : `${live.length} open`}</h2>
        <button type="button" className="btn-strong" data-testid="work-card-add-toggle" onClick={() => setAdding((a) => !a)}>
          {adding ? "Cancel" : "Add a card"}
        </button>
      </div>

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

      {message && <p className="notice" data-testid="work-cards-message">{message}</p>}

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
          <label className="muted small work-allow-browser">
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
          <p className="muted small">
            A card without a next action is a wish. Naming the next step is what makes it work
            somebody can pick up.
          </p>
        </form>
      )}

      {live.length === 0 && !adding && (
        <div className="card" data-testid="work-cards-empty">
          <h3>Nothing is open</h3>
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
        <section key={group.key} data-testid={`work-owner-${group.key}`}>
          <div className="home-section-head">
            <h3>
              {group.name} <span className="count-pill">{group.cards.length}</span>
            </h3>
            <span className="muted small">{group.note}</span>
          </div>

          <ul className="work-card-grid" data-testid={`work-card-list-${group.key}`}>
            {group.cards.map((c) => {
              const meaning = stateMeaning(c.state);
              const isOpen = openCards.has(c.id);
              return (
                <li key={c.id} className={isOpen ? "card work-card-row is-open" : "card work-card-row"} data-testid={`work-card-${c.id}`}>
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
                      {c.priority !== "NORMAL" && <span className="badge badge-gate">{c.priority.toLowerCase()}</span>}
                      {/* Two facts survive the collapse because they change what you do next. */}
                      {/* "12 looks" meant nothing to anybody — the operator's question was
                          literally "what is a fucking look?". It is a web page this card opened
                          and read. Say that. */}
                      {(c.looks ?? []).length > 0 && (
                        <span className="muted small" title="Web pages this card has opened and read">
                          {c.looks!.length} page{c.looks!.length === 1 ? "" : "s"} read
                        </span>
                      )}
                      {c.due_at && <span className="muted small">due {c.due_at.slice(0, 10)}</span>}
                      <span className={`work-card-chevron${isOpen ? " is-open" : ""}`} aria-hidden="true">›</span>
                    </span>

                    <strong className="work-card-title">{c.title}</strong>

                    {/* WHO, WITH A FACE. Every employee has a portrait now, and a face is the
                        fastest way to read a board — you find Wyatt's cards by looking for Wyatt,
                        not by reading eight owner lines. */}
                    <span className="work-card-foot">
                      <OwnerChip name={c.owner_type === "UNASSIGNED" ? null : c.owner_name ?? null} />
                      {c.next_action && <span className="muted small work-card-next">{c.next_action}</span>}
                    </span>
                  </button>

                  {isOpen && (
                    <>
              <div className="work-card-body">
                {c.next_action ? (
                  <div>
                    <p className="lbl">Next</p>
                    {/* Usually one line. When an employee blocks, its whole question lands here,
                        which is a paragraph — so this is bounded like the findings are. */}
                    <div className="work-card-longtext">{c.next_action}</div>
                  </div>
                ) : (
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
                  {c.due_at ? ` · due ${c.due_at.slice(0, 10)}` : ""}
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

      {finished.length > 0 && (
        <details className="card" data-testid="work-cards-finished">
          <summary>{finished.length} finished or dropped</summary>
          <p className="muted small">
            Kept rather than deleted — what got done is the record, and a decision not to act is
            still a decision.
          </p>
          <ul className="card-list small">
            {finished.slice(0, 50).map((c) => (
              <li key={c.id}>
                <span className="badge">{stateMeaning(c.state)?.label ?? c.state}</span> {c.title}
                {/* CHANGING YOUR MIND HAS TO BE POSSIBLE. A dropped or finished card is kept
                    rather than deleted precisely because the decision might be revisited. Reopens
                    as OPEN, not to whatever it was before: what it was is history, what it is now
                    is undecided.

                    This button existed for dropped cards and did nothing — the server's transition
                    table allowed no move at all out of CANCELLED, so every press returned a 409 the
                    page reported as a small notice most of the way up. Finished cards were never
                    offered it at all, though reopening one was always legal. */}
                <button
                  type="button"
                  className="link-button"
                  data-testid={`work-card-undrop-${c.id}`}
                  onClick={() => void move(c.id, "OPEN")}
                >
                  {c.state === "CANCELLED" ? "Put it back" : "Reopen"}
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}



    </section>
  );
}
