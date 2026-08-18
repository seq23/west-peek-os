import { useState } from "react";
import { api, useApi } from "../lib/api";
import { HowThisWorks } from "./HowThisWorks";
import { EXIT_TYPES, headingLabel } from "@shared/review/weeklyAgenda";

/**
 * The weekly MP operating review (P37, V1 #18, canon §8).
 *
 * Sixteen headings, and a heading with nothing under it is SHOWN AS EMPTY rather than hidden. That
 * is the opposite of the usual instinct, and it is the point: "no unresolved commitments this week"
 * is a real finding, while a missing heading just looks like the page forgot.
 *
 * Every line carries where it came from, because an agenda item a partner cannot trace is an
 * assertion.
 */

interface Item {
  id: string; heading: string; body: string; exit_type: string; exit_note: string | null;
  raised_by: string; source_type: string | null; source_id: string | null;
}
interface Payload {
  review: { id: string; week_start: string; generated_at: string; state: string } | null;
  items: Item[];
  headings: ReadonlyArray<{ key: string; label: string }>;
  resolved: boolean;
  unresolved: number;
}

const RAISED_LABEL: Record<string, string> = { BOTH: "both partners", SCOOTER: "Scooter only", SEQUOIA: "Sequoia only" };

export function WeeklyReviewPage(): JSX.Element {
  const state = useApi<Payload>("/api/weekly-review");
  const [busy, setBusy] = useState(false);

  const items = state.data?.items ?? [];
  const review = state.data?.review ?? null;
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

  return (
    <div className="page" data-testid="weekly-review-page">
      <h2>Weekly review</h2>
      <p className="muted">
        One reconciled agenda across the whole firm, derived from live records — not written by a model.
      </p>

      <div className="form-row">
        <button type="button" className="btn-strong" disabled={busy} data-testid="weekly-generate" onClick={generate}>
          {busy ? "Assembling…" : review ? "Regenerate this week" : "Generate this week"}
        </button>
        {review && (
          <span className="muted small" data-testid="weekly-meta">
            Week of {review.week_start} · assembled {new Date(review.generated_at).toLocaleString()}
          </span>
        )}
      </div>

      {review && (
        <p className={state.data!.resolved ? "notice" : "notice notice-warn"} data-testid="weekly-status">
          {state.data!.resolved
            ? "Every item has an exit. The review is complete."
            : `${state.data!.unresolved} item${state.data!.unresolved === 1 ? "" : "s"} still without an exit.`}
        </p>
      )}

      {!review && <p className="state-empty" data-testid="weekly-empty">No review for this week yet.</p>}

      {review &&
        (state.data?.headings ?? []).map((h) => {
          const rows = byHeading.get(h.key) ?? [];
          return (
            <section className="card" key={h.key} data-testid={`weekly-heading-${h.key}`}>
              <h3>
                {h.label} <span className="muted small">{rows.length}</span>
              </h3>
              {rows.length === 0 ? (
                /* Shown, not hidden — "nothing here" is a finding. */
                <p className="state-empty">Nothing this week.</p>
              ) : (
                <ul className="card-list small">
                  {rows.map((i) => (
                    <li key={i.id} data-testid={`weekly-item-${i.id}`}>
                      <span className={i.exit_type === "UNRESOLVED" ? "help-tag help-tag-warn" : "help-tag help-tag-good"}>
                        {EXIT_TYPES.find((e) => e.key === i.exit_type)?.label ?? i.exit_type}
                      </span>{" "}
                      {i.body}
                      <div className="muted small">
                        raised by {RAISED_LABEL[i.raised_by] ?? i.raised_by}
                        {i.source_type && ` · from ${i.source_type}`}
                      </div>
                      <select
                        data-testid={`weekly-exit-${i.id}`}
                        value={i.exit_type}
                        onChange={(e) => setExit(i.id, e.target.value)}
                        aria-label={`How ${headingLabel(i.heading)} item exited`}
                      >
                        {EXIT_TYPES.map((e) => (
                          <option key={e.key} value={e.key}>{e.label}</option>
                        ))}
                      </select>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}

      <HowThisWorks
        title="Weekly review"
        testId="weekly-review"
        what="One agenda across sixteen areas of the firm, assembled from records that already exist — pending approvals, open commitments, portfolio alerts, failing jobs."
        when="Once a week, as the operating review both partners work through together."
        operatorDoes={["Generate the agenda.", "Work down it.", "Give every item an exit: decision, owner, deadline, delegated, deferred or closed."]}
        aiDoes={["Nothing writes the agenda. Items are derived from live records so every line traces to a row."]}
        requiresOperator={["Every exit. The review is only finished when nothing is left unresolved."]}
        next="Regenerating keeps items you have already resolved and refreshes the rest, so a mid-week refresh never erases the partners' decisions."
        blocked={["An item only appears if the record behind it exists — an empty heading means nothing matched, which is itself worth knowing."]}
      />
    </div>
  );
}
