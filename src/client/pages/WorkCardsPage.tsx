import { useMemo, useState } from "react";
import { api, useApi, type MeResponse } from "../lib/api";
import { CARD_SOURCES, STATE_MEANINGS, stateMeaning, triage } from "@shared/work/workCards";
import { BrowserTasksPage } from "./BrowserTasksPage";

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
}

interface RecentRun {
  ai_employee_id: string;
  employee_name: string;
  purpose: string;
  status: string;
  created_at: string;
}

export function WorkCardsPage({ me, onChanged, onNavigate }: { me: MeResponse; onChanged: () => void; onNavigate: (k: string) => void }) {
  const board = useApi<{
    cards: WorkCardRow[];
    recent_runs: RecentRun[];
    assignable: { employees: Array<{ id: string; name: string; role: string }>; partners: Array<{ id: string; full_name: string }> };
  }>("/api/work-cards/by-owner");
  const [message, setMessage] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [nextAction, setNextAction] = useState("");
  // Defaults to you. Assigning to your partner or to an employee is the same act either way.
  const [owner, setOwner] = useState(`HUMAN:${me.id}`);
  const [busy, setBusy] = useState(false);

  const all = board.data?.cards ?? [];
  const live = useMemo(() => triage(all), [all]);
  const finished = all.filter((c) => c.state === "DONE" || c.state === "CANCELLED");
  const runs = board.data?.recent_runs ?? [];

  /**
   * Work grouped by whoever is carrying it. Unassigned comes first: a card nobody owns is the most
   * likely thing here to be quietly dropped, and a flat list hides exactly that.
   */
  const byOwner = useMemo(() => {
    const groups = new Map<string, { owner: Owner; cards: WorkCardRow[] }>();
    for (const c of live) {
      const key = c.owner_type === "UNASSIGNED" || !c.owner_id ? "nobody" : `${c.owner_type}:${c.owner_id}`;
      if (!groups.has(key)) {
        groups.set(key, {
          owner: {
            key,
            name: key === "nobody" ? "Nobody yet" : c.owner_name ?? c.owner_id ?? "Unknown",
            role: c.owner_role ?? null,
            kind: key === "nobody" ? "NOBODY" : (c.owner_type as "AI" | "HUMAN"),
          },
          cards: [],
        });
      }
      groups.get(key)!.cards.push(c);
    }
    return [...groups.values()].sort((a, b) => (a.owner.kind === "NOBODY" ? -1 : b.owner.kind === "NOBODY" ? 1 : 0));
  }, [live]);

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
    setMessage(owner === `HUMAN:${me.id}` ? "Added, owned by you." : "Added and handed over.");
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
        <button type="button" className="link-button" data-testid="work-card-add-toggle" onClick={() => setAdding((a) => !a)}>
          {adding ? "Cancel" : "Add a card"}
        </button>
      </div>

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

      {byOwner.map((group) => (
        <section key={group.owner.key} data-testid={`work-owner-${group.owner.key}`}>
          <div className="home-section-head">
            <h3>
              {group.owner.name}
              {group.owner.role && <span className="muted small"> {group.owner.role}</span>}
            </h3>
            <span className="muted small">
              {group.owner.kind === "NOBODY"
                ? "Nobody has picked these up"
                : `${group.cards.length} open`}
            </span>
          </div>

          <ul className="card-list" data-testid={`work-card-list-${group.owner.key}`}>
            {group.cards.map((c) => {
              const meaning = stateMeaning(c.state);
              return (
                <li key={c.id} className="card work-card-row" data-testid={`work-card-${c.id}`}>
              <div className="work-card-body">
                <div className="notification-head">
                  <span className={c.state === "BLOCKED" ? "badge badge-bad" : "badge"}>
                    {meaning?.label ?? c.state}
                  </span>
                  {c.priority !== "NORMAL" && <span className="badge badge-gate">{c.priority.toLowerCase()}</span>}
                  <strong>{c.title}</strong>
                </div>
                {c.next_action ? (
                  <p className="small">
                    <span className="lbl">Next</span> {c.next_action}
                  </p>
                ) : (
                  <p className="muted small">No next action — nobody knows what to do with this yet.</p>
                )}
                <p className="muted small">
                  {c.owner_type === "UNASSIGNED" ? "Nobody owns this" : `Owned by ${c.owner_id ?? c.owner_type.toLowerCase()}`}
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
                  </div>
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
              </li>
            ))}
          </ul>
        </details>
      )}

      {/* GO AND LOOK LIVES HERE NOW. It sat under Admin, which is where you go to configure the
          system rather than to get something done — so the one capability that can go and read a
          live page for you was filed with the plumbing. Sending an employee to check a page is
          work, it produces something you then act on, and this is the page about work. */}
      <details className="card summary-button" data-testid="work-browser-tasks">
        <summary>Send someone to go and look at a page</summary>
        <p className="muted small">
          This is the only thing here that reaches out and reads the live web for you. You give an
          employee a page and a question — <em>does this company still list a VP of Sales</em>,{" "}
          <em>what are their pricing tiers now</em>, <em>who is named on the about page</em> — and
          they open it, read it and report back. You approve each one before it runs, and what
          comes back is quoted as information about the world, never as instructions.
        </p>
        <p className="muted small">
          Best for small, checkable questions where the answer is written on a page. Anything
          needing judgement rather than looking belongs with a person.
        </p>
        <BrowserTasksPage me={me} />
      </details>

      <details className="card" data-testid="work-cards-explainer">
        <summary>What the states mean</summary>
        <ul className="card-list small">
          {STATE_MEANINGS.map((s) => (
            <li key={s.key}>
              <strong>{s.label}</strong> — {s.means}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
