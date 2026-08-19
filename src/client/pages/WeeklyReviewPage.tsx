import { useState } from "react";
import { api, useApi } from "../lib/api";
import { HowThisWorks } from "./HowThisWorks";
import { EXIT_TYPES, headingLabel } from "@shared/review/weeklyAgenda";

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

function shortDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

export function WeeklyReviewPage(): JSX.Element {
  const state = useApi<Payload>("/api/weekly-review");
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [lastAdded, setLastAdded] = useState<{ id: string; heading: string; guessed: boolean } | null>(null);

  const d = state.data;
  const items = d?.items ?? [];
  const review = d?.review ?? null;

  const byHeading = new Map<string, Item[]>();
  for (const i of items) {
    if (!byHeading.has(i.heading)) byHeading.set(i.heading, []);
    byHeading.get(i.heading)!.push(i);
  }

  async function generate() {
    setBusy(true);
    await api("/api/weekly-review/generate", { method: "POST", body: {} });
    setBusy(false);
    state.reload();
  }

  async function setExit(id: string, exit_type: string) {
    await api(`/api/weekly-review/items/${id}/exit`, { method: "POST", body: { exit_type } });
    state.reload();
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

  return (
    <div className="page" data-testid="weekly-review-page">
      <h2>Weekly review</h2>

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
            data-testid="weekly-dump-input"
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

      <div className="form-row">
        <button type="button" disabled={busy} data-testid="weekly-generate" onClick={generate}>
          {busy ? "Assembling…" : review ? "Refresh from records" : "Open this week"}
        </button>
        {review && (
          <span className="muted small" data-testid="weekly-meta">
            assembled {new Date(review.generated_at).toLocaleString()} · your own notes are kept
          </span>
        )}
      </div>

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
              <h3>
                {h.label} <span className="muted small">{rows.length}</span>
              </h3>
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
                      {/* A typed item says who thought of it; a derived one says which record it
                          came from. Never blurred — that distinction is why the derived half can
                          be trusted at all. */}
                      {i.source_type === "operator"
                        ? `${RAISED_LABEL[i.raised_by] ?? i.raised_by} raised this`
                        : `from ${i.source_type ?? "the record"} · raised by ${RAISED_LABEL[i.raised_by] ?? i.raised_by}`}
                      {i.work_card_id && " · work card created"}
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
