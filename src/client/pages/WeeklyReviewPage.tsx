import { useState } from "react";
import { api, mutationError, useApi } from "../lib/api";
import { HowThisWorks } from "./HowThisWorks";
import { EXIT_TYPES, headingLabel, REFRESH_READS, isTyped, sourceWords } from "@shared/review/weeklyAgenda";
import { jointByline } from "@shared/work/chiefOfStaff";

/**
 * The weekly MP operating review (P37, V1 #18, canon §8).
 *
 * WEDNESDAY TO TUESDAY, because that is when the firm meets. The week used to start on Monday,
 * which put the meeting in the middle of the period it was reviewing — everything decided in the
 * room landed on the next week's agenda instead of closing out the one on the table.
 *
 * ONLY HEADINGS WITH SOMETHING UNDER THEM. The previous version showed all sixteen and argued that
 * an empty heading is a finding. It is — when the heading COULD have had something. Nine of the
 * sixteen have no derivation at all and can never populate, so what the page actually taught was
 * that most of it is always blank, and a partner who learns to skim stops reading the two lines
 * that matter. A heading returns the moment something lands under it.
 *
 * THE CAPTURE BOX IS THE POINT OF THE REDESIGN. Everything else here is derived from a row, which
 * is what makes the agenda checkable and is worth keeping. But what actually decides a fund's week
 * lives in two people's heads, and it had nowhere to go. Typed items are marked as raised by a
 * person rather than dressed up as derived — that distinction is the whole reason the derived half
 * can be trusted.
 *
 * EXITS PRODUCE WORK. Owner, deadline and delegated action raise a work card. Before this the six
 * exits updated a column and stopped, so a real decision in a real meeting was gone by Thursday.
 */

interface Item {
  id: string; heading: string; body: string; exit_type: string; exit_note: string | null;
  raised_by: string; source_type: string | null; source_id: string | null;
  deferred_count?: number; work_card_id?: string | null;
}
interface Payload {
  review: { id: string; week_start: string; generated_at: string; state: string } | null;
  items: Item[];
  week_end?: string;
  headings: ReadonlyArray<{ key: string; label: string }>;
  all_headings: ReadonlyArray<{ key: string; label: string }>;
  resolved: boolean;
  unresolved: number;
  decisions_waiting: number;
  carried_over: number;
  most_deferred: Item | null;
}

const RAISED_LABEL: Record<string, string> = {
  BOTH: "both partners",
  SCOOTER: "Scooter",
  SEQUOIA: "Sequoia",
};

/** Which exits produce a work card, so the interface can say so before you pick one. */
const RAISES_WORK = new Set(["OWNER", "DEADLINE", "DELEGATED_ACTION"]);

interface Proposal {
  heading: string;
  body: string;
  owner_hint: string | null;
  owner_id: string | null;
  deadline: string | null;
  quote: string;
}

function shortDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

export function WeeklyReviewPage({ onNavigate }: { onNavigate: (k: string) => void }): JSX.Element {
  const state = useApi<Payload>("/api/weekly-review");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  /**
   * Take an item off the agenda. Confirmed only when it cannot come back — a derived item removed
   * this week reappears next week if the record behind it is still open, so asking about that
   * would be a dialog for something reversible.
   */
  async function removeItem(id: string) {
    const res = await api<{ was_typed?: boolean }>(`/api/weekly-review/items/${id}/remove`, { method: "POST" });
    if (res.status !== 200) setNotesMessage(`Could not remove it (HTTP ${res.status}).`);
    state.reload();
  }

  const [draft, setDraft] = useState("");
  const [lastAdded, setLastAdded] = useState<{ id: string; heading: string; guessed: boolean } | null>(null);
  const [notes, setNotes] = useState("");
  const [sensitivity, setSensitivity] = useState("INTERNAL");
  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  const [notesMessage, setNotesMessage] = useState<string | null>(null);

  const d = state.data;
  const items = d?.items ?? [];
  const review = d?.review ?? null;

  const byHeading = new Map<string, Item[]>();
  for (const i of items) {
    if (!byHeading.has(i.heading)) byHeading.set(i.heading, []);
    byHeading.get(i.heading)!.push(i);
  }

  /*
   * EVERY HANDLER ON THIS PAGE READS ITS RESULT NOW.
   *
   * All five weekly-review routes gate on `weekly_review.manage` and can answer 403. Written as a
   * bare `await api(...)` they were silent about it, so the page a partner runs the operating
   * meeting from could refuse every action and look exactly like a quiet week.
   */
  async function generate() {
    setBusy(true);
    const failed = mutationError(await api("/api/weekly-review/generate", { method: "POST", body: {} }));
    setBusy(false);
    setFailure(failed);
    if (!failed) state.reload();
  }

  async function setExit(id: string, exit_type: string) {
    const failed = mutationError(await api(`/api/weekly-review/items/${id}/exit`, { method: "POST", body: { exit_type } }));
    setFailure(failed);
    if (!failed) state.reload();
  }

  /** Put a thought on the agenda. Heading omitted on purpose — the server guesses it. */
  async function dump(e: React.FormEvent) {
    e.preventDefault();
    const body = draft.trim();
    if (body.length < 3) return;
    setBusy(true);
    const res = await api<{ item: Item; guessed: boolean }>("/api/weekly-review/items", {
      method: "POST",
      body: { body },
    });
    setBusy(false);
    if (res.status === 201 && res.data) {
      setDraft("");
      setLastAdded({ id: res.data.item.id, heading: res.data.item.heading, guessed: res.data.guessed });
    }
    state.reload();
  }

  /** Move a mis-guessed item. One control, because the guess being wrong has to be cheap. */
  async function refile(id: string, heading: string) {
    await api(`/api/weekly-review/items/${id}/heading`, { method: "POST", body: { heading } });
    setLastAdded((prev) => (prev && prev.id === id ? { ...prev, heading, guessed: false } : prev));
    state.reload();
  }

  /** Read pasted notes into PROPOSED items. Writes nothing. */
  async function readNotes(e: React.FormEvent) {
    e.preventDefault();
    if (notes.trim().length < 20) return;
    setBusy(true);
    setNotesMessage(null);
    const res = await api<{ proposals: Proposal[]; note: string; detail?: string; error?: string }>(
      "/api/weekly-review/notes",
      { method: "POST", body: { notes: notes.trim(), sensitivity } },
    );
    setBusy(false);
    if (res.status === 200 && res.data) {
      setProposals(res.data.proposals);
      setNotesMessage(res.data.note);
    } else {
      setProposals(null);
      setNotesMessage(res.data?.detail ?? res.data?.error ?? `Could not read those notes (HTTP ${res.status}).`);
    }
  }

  /** Put one proposal on the agenda. Nothing is written until this is pressed. */
  /*
   * THE PROPOSAL IS ONLY REMOVED IF IT WAS ACTUALLY SAVED. Previously it was filtered out of the
   * list regardless, so a refused item vanished from the screen and never reached the agenda —
   * the operator saw it accepted and it did not exist.
   */
  async function accept(p: Proposal, index: number) {
    const failed = mutationError(
      await api("/api/weekly-review/items", {
        method: "POST",
        body: {
          body: p.body,
          heading: p.heading,
          from_notes: true,
          ...(p.owner_id ? { owner_id: p.owner_id } : {}),
          ...(p.deadline ? { deadline: p.deadline } : {}),
        },
      }),
    );
    setFailure(failed);
    if (failed) return;
    setProposals((prev) => (prev ? prev.filter((_, n) => n !== index) : prev));
    state.reload();
  }

  return (
    <div className="page" data-testid="weekly-review-page">
      {failure && (
        <p className="notice notice-gate small" data-testid="weekly-review-failed" role="alert">
          {failure}
        </p>
      )}

      {/* THE HEADER ANSWERS THE THREE QUESTIONS SOMEBODY OPENS THIS PAGE WITH: which week, how much
          is outstanding, and what has been sitting here too long. */}
      {review && (
        <div className="review-masthead" data-testid="weekly-masthead">
          <div>
            <strong>
              {shortDate(review.week_start)}
              {d?.week_end ? ` → ${shortDate(d.week_end)}` : ""}
            </strong>
            <div className="muted small">
              {items.length} item{items.length === 1 ? "" : "s"}
              {d && d.decisions_waiting > 0 && ` · ${d.decisions_waiting} waiting on a decision`}
              {d && d.carried_over > 0 && ` · ${d.carried_over} carried over`}
            </div>
          </div>
          <span className={d?.resolved ? "badge badge-ok" : "badge badge-gate"} data-testid="weekly-status">
            {d?.resolved ? "complete" : `${d?.unresolved ?? 0} unresolved`}
          </span>
        </div>
      )}

      {/* SIGNED BY BOTH CHIEFS OF STAFF. This is one document two partners work through, so it is
          prepared jointly rather than by whichever of them happened to open it — an agenda that
          looks like it belongs to one partner is one the other stops treating as theirs. The
          derivation is machinery; the delivery has a face, which is the same reason the morning
          brief carries a name. */}
      {review && (
        <p className="muted small" data-testid="weekly-byline">
          Prepared for you both by <strong>{jointByline()}</strong>, your Chiefs of Staff — assembled
          from live records, decided by nobody but you.
        </p>
      )}

      {/* The oldest thing still on the table. By the third deferral this line is usually more
          informative than the item's own text. */}
      {d?.most_deferred && (d.most_deferred.deferred_count ?? 0) > 0 && (
        <p className="notice small" data-testid="weekly-most-deferred">
          <strong>Longest outstanding:</strong> “{d.most_deferred.body}” — deferred{" "}
          {d.most_deferred.deferred_count} time{d.most_deferred.deferred_count === 1 ? "" : "s"}.
        </p>
      )}

      {/* ── The capture box ─────────────────────────────────────────────────────
          At the TOP, always present, before anything derived. A thought arrives during the meeting
          and has to survive the moment it occurs; putting the box below the agenda would mean
          scrolling past everything to record something you just said out loud. */}
      <form className="card review-capture" onSubmit={dump} data-testid="weekly-capture">
        <label htmlFor="weekly-dump">
          <strong>What&apos;s on your mind?</strong>
          <span className="muted small"> Type anything — it goes on this week&apos;s agenda.</span>
        </label>
        <div className="form-row">
          <input
            id="weekly-dump"
            data-testid="weekly-dump-input" aria-label="Anything on your mind for this week"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="LP intro from Marcus — worth chasing?"
            style={{ flexGrow: 1 }}
          />
          <button type="submit" className="btn-strong" disabled={busy || draft.trim().length < 3}>
            {busy ? "…" : "Add"}
          </button>
        </div>
        {lastAdded && (
          <p className="muted small" data-testid="weekly-dump-result">
            Filed under <strong>{headingLabel(lastAdded.heading)}</strong>
            {lastAdded.guessed && " — we guessed"}.{" "}
            {lastAdded.guessed && (
              <select
                data-testid="weekly-dump-refile"
                defaultValue={lastAdded.heading}
                onChange={(e) => void refile(lastAdded.id, e.target.value)}
                aria-label="Move to a different heading"
              >
                {(d?.all_headings ?? []).map((h) => (
                  <option key={h.key} value={h.key}>{h.label}</option>
                ))}
              </select>
            )}
          </p>
        )}
      </form>

      {/* ── Meeting notes ──────────────────────────────────────────────────────
          The notetaker emails a summary after every call. Pasting it here turns prose into agenda
          items — which is the actual work; how the text arrives is incidental. Nothing is written
          until a partner accepts a line, because a model reading a meeting and silently filling the
          agenda would put words in two partners' mouths on the page they decide from. */}
      <details className="card summary-button" data-testid="weekly-notes">
        <summary>Paste meeting notes</summary>
        <p className="muted small">
          Paste what your notetaker sent. It comes back as suggested agenda items with the sentence
          each one came from, and nothing goes on the agenda until you accept it. The notes
          themselves are never stored — only the lines you keep.
        </p>
        <form onSubmit={readNotes}>
          <textarea
            data-testid="weekly-notes-input" aria-label="Paste your meeting notes"
            rows={6}
            style={{ width: "100%" }}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Paste the notetaker summary here…"
          />
          <div className="form-row">
            <label>
              These notes are{" "}
              <select
                data-testid="weekly-notes-sensitivity"
                value={sensitivity}
                onChange={(e) => setSensitivity(e.target.value)}
              >
                <option value="INTERNAL">ordinary firm business</option>
                <option value="PUBLIC">nothing sensitive</option>
                <option value="LP_PRIVATE">about specific LPs</option>
                <option value="CONFIDENTIAL">confidential</option>
                <option value="MNPI_SENSITIVE">material non-public</option>
              </select>
            </label>
            <button type="submit" className="btn-strong" disabled={busy || notes.trim().length < 20}>
              {busy ? "Reading…" : "Read them"}
            </button>
          </div>
          <p className="muted small">
            The last three are refused rather than sent anywhere — say so and add those items by
            hand instead.
          </p>
        </form>

        {notesMessage && <p className="notice small" data-testid="weekly-notes-message">{notesMessage}</p>}

        {proposals && proposals.length > 0 && (
          <ul className="card-list small" data-testid="weekly-proposals">
            {proposals.map((p, n) => (
              <li key={`${p.body}-${n}`}>
                <div>
                  <strong>{p.body}</strong>{" "}
                  <span className="badge">{headingLabel(p.heading)}</span>
                  {p.owner_id && <span className="badge badge-ok">{p.owner_id.includes("scooter") ? "Scooter" : "Sequoia"}</span>}
                  {p.deadline && <span className="badge badge-gate">by {p.deadline}</span>}
                </div>
                {/* The sentence it came from, so you check the reading rather than trust it. */}
                {p.quote && <div className="muted small">“{p.quote}”</div>}
                <div className="form-row">
                  <button type="button" className="btn-strong" onClick={() => void accept(p, n)}>
                    Put on the agenda
                  </button>
                  <button
                    type="button"
                    onClick={() => setProposals((prev) => (prev ? prev.filter((_, i) => i !== n) : prev))}
                  >
                    Discard
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </details>

      <div className="form-row">
        <button type="button" className="btn-strong" disabled={busy} data-testid="weekly-generate" onClick={generate}>
          {busy ? "Assembling…" : review ? "Pull in what has changed" : "Open this week"}
        </button>
        {review && (
          <span className="muted small" data-testid="weekly-meta">
            assembled {new Date(review.generated_at).toLocaleString()}
          </span>
        )}
      </div>

      {/* WHAT THAT BUTTON DOES. It said "Refresh from records" and the operator's response was
          "what does that mean" — fair, since "records" could mean anything in a system with two
          hundred tables. Naming the eight places it looks is the whole explanation, and the
          reassurance underneath is the half people actually worry about. */}
      <details className="card" data-testid="weekly-refresh-explainer">
        <summary className="muted small">What that pulls in</summary>
        <p className="small">It reads eight places and raises anything that needs the two of you:</p>
        <ul className="card-list small">
          {REFRESH_READS.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
        <p className="muted small">
          It never touches what you typed into the box or accepted from meeting notes, and it never
          reopens something you have already decided. Anything you deferred last week comes back by
          itself, with a count of how many times it has been put off.
        </p>
      </details>

      {!review && (
        <p className="state-empty" data-testid="weekly-empty">
          Nothing open for this week yet. Type something above, or refresh from records.
        </p>
      )}

      {review && items.length === 0 && (
        <p className="state-empty" data-testid="weekly-nothing">
          Nothing has come up this week. That is a real finding, not a broken page — no approvals
          waiting, no portfolio alerts, no failed jobs.
        </p>
      )}

      {review &&
        (d?.headings ?? []).map((h) => {
          const rows = byHeading.get(h.key) ?? [];
          if (rows.length === 0) return null;
          return (
            <section className="card" key={h.key} data-testid={`weekly-heading-${h.key}`}>
              <h4>
                {h.label} <span className="muted small">{rows.length}</span>
              </h4>
              <ul className="card-list small">
                {rows.map((i) => (
                  <li key={i.id} data-testid={`weekly-item-${i.id}`}>
                    <div>
                      <span className={i.exit_type === "UNRESOLVED" ? "help-tag help-tag-warn" : "help-tag help-tag-good"}>
                        {EXIT_TYPES.find((e) => e.key === i.exit_type)?.label ?? i.exit_type}
                      </span>{" "}
                      {i.body}
                      {(i.deferred_count ?? 0) > 0 && (
                        <span className="badge badge-gate" title="Carried over from a previous week">
                          deferred {i.deferred_count}×
                        </span>
                      )}
                    </div>
                    <div className="muted small">
                      {/* WHERE IT CAME FROM, in words. This printed the raw table name — the
                          agenda literally said `from investment_opportunity` — and for a typed
                          item it said "Sequoia raised this", which answers who rather than how.
                          The operator could not place an item they had written themselves. */}
                      {sourceWords(i.source_type).said}
                      {!isTyped(i.source_type) && ` · raised by ${RAISED_LABEL[i.raised_by] ?? i.raised_by}`}
                      {sourceWords(i.source_type).page && (
                        <>
                          {" "}
                          <button
                            type="button"
                            className="link-button"
                            data-testid={`weekly-source-${i.id}`}
                            onClick={() => onNavigate(sourceWords(i.source_type).page!)}
                          >
                            open it
                          </button>
                        </>
                      )}
                      {i.work_card_id && " · work card created"}
                      {" · "}
                      <button
                        type="button"
                        className="link-button"
                        data-testid={`weekly-remove-${i.id}`}
                        title={isTyped(i.source_type)
                          ? "Removes it for good — nothing can re-derive something you typed"
                          : "Takes it off this week. It comes back if the record is still open"}
                        onClick={() => void removeItem(i.id)}
                      >
                        remove
                      </button>
                    </div>
                    <select
                      data-testid={`weekly-exit-${i.id}`}
                      value={i.exit_type}
                      onChange={(e) => setExit(i.id, e.target.value)}
                      aria-label={`How this ${headingLabel(i.heading)} item exited`}
                    >
                      {EXIT_TYPES.map((e) => (
                        <option key={e.key} value={e.key}>
                          {e.label}
                          {RAISES_WORK.has(e.key) ? " → makes a work card" : ""}
                        </option>
                      ))}
                    </select>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}

      <HowThisWorks
        title="Weekly review"
        testId="weekly-review"
        what="One agenda for the week running Wednesday to Tuesday, assembled from records that already exist — pending approvals, open commitments, portfolio alerts, failing jobs — plus anything either partner types into it."
        when="Wednesday, as the operating review both partners work through together. It regenerates on its own; you never have to remember to."
        operatorDoes={[
          "Type whatever is on your mind — it goes on the agenda and is filed for you.",
          "Work down the list.",
          "Give every item an exit: decision, owner, deadline, delegated, deferred or closed.",
        ]}
        aiDoes={["Nothing writes the agenda. Derived items trace to a row; typed items say who raised them."]}
        requiresOperator={["Every exit. The review is only finished when nothing is left unresolved."]}
        next="Owner, deadline and delegated action each raise a work card, so a decision made here turns into work rather than staying in a document. Deferred items return automatically next Wednesday, carrying a count of how often they have been put off."
        blocked={[
          "A heading only appears once something lands under it, so the page stays short enough to read.",
          "Refreshing keeps your typed notes and anything you have already resolved.",
        ]}
      />
    </div>
  );
}
