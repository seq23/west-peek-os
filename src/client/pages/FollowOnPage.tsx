import { useState } from "react";
import { api, useApi } from "../lib/api";
import { HowThisWorks } from "./HowThisWorks";

/**
 * Follow-On Decision Centre (P35, V1 #39, canon §12.4).
 *
 * Two lists kept deliberately apart: reviews the firm has already opened, and companies that look
 * like they warrant one. Merging them would blur a recorded decision with a suggestion, and the
 * whole value of this surface is knowing which is which.
 *
 * The candidate rule is PRINTED ON THE PAGE. A ranked list with an unstated rule invites the reader
 * to assume judgement that was never applied — these are companies where one number went up, not
 * companies the system thinks you should back.
 *
 * WHAT "CANDIDATE" MEANS, settled 21 Aug 2026. The word used to name two different populations:
 * these companies, and separately the undecided options sitting in an allocation scenario, which the
 * Cockpit also called "follow-on candidates" and which included reserves. The two pages could print
 * different counts and both be right. Detection owns the word now; the Cockpit panel is named for
 * what it holds. The four stages are stated on the page so a partner can see where a company is.
 */

interface Review {
  id: string; company_id: string; company_name: string | null; status: string;
  reviewed_by: string | null; reviewed_at: string | null; review_note: string | null; created_at: string;
}
interface Candidate {
  company_id: string; company_name: string; metric_key: string;
  latest_value: number; previous_value: number; as_of_date: string;
  /** The holding this would be a follow-on TO. Carried so a review can be opened from this row. */
  position_id: string | null; held_shares: number | null; existing_cost: number | null; fund_id: string | null;
}

interface Scenario { id: string; name: string; }

function pct(a: number, b: number): string {
  if (!b) return "—";
  return `${(((a - b) / b) * 100).toFixed(0)}%`;
}

export function FollowOnPage(): JSX.Element {
  const state = useApi<{ reviews: Review[]; pending_count: number; candidates: Candidate[]; candidate_rule: string }>("/api/follow-on");
  const scenarios = useApi<{ scenarios: Scenario[] }>("/api/allocation/scenarios");
  /*
   * OPENING A REVIEW FROM THE ROW THAT NAMED THE COMPANY — the join that did not exist.
   *
   * `POST /api/allocation/scenarios/:id/follow-on-reviews` was live and correct, and nothing in
   * `src/client` posted to it. So the product could tell a partner "Sensori is pulling ahead" and
   * give her nowhere to press. Detection worked, the review worked, the decision worked, and the
   * step between the first and the second was missing entirely.
   *
   * WHY THERE IS A FORM AND NOT A BUTTON. A follow-on review IS the economics — the route computes
   * and stores a modelled path, so the figures are the substance rather than paperwork in front of
   * it. What can be derived is derived and shown as such; what only a partner knows about the round
   * is asked for, and nothing is invented behind her back. A one-press version would have to make
   * up a round size, which is precisely the fabricated-inputs defect that made Fund strategy answer
   * questions against a fund the firm does not have.
   */
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [scenarioId, setScenarioId] = useState("");
  const [roundSize, setRoundSize] = useState("");
  const [primaryPps, setPrimaryPps] = useState("");
  const [targetPct, setTargetPct] = useState("");
  const [maxAllocation, setMaxAllocation] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const ready = scenarioId !== "" && [roundSize, primaryPps, targetPct, maxAllocation].every((v) => Number(v) > 0);

  async function openReview(c: Candidate) {
    setBusy(true);
    setMessage(null);
    const res = await api<{ id?: string; detail?: string; error?: string }>(
      `/api/allocation/scenarios/${scenarioId}/follow-on-reviews`,
      {
        method: "POST",
        body: {
          company_id: c.company_id,
          ...(c.position_id ? { position_id: c.position_id } : {}),
          path: {
            // What the firm already holds, taken from the position rather than retyped.
            currentFullyDilutedShares: Number(c.held_shares ?? 0),
            existingCost: Number(c.existing_cost ?? 0),
            currentOwnershipPct: 0,
            // What the partner has just said about the round.
            roundSize: Number(roundSize),
            primaryPps: Number(primaryPps),
            targetOwnershipPct: Number(targetPct),
            maxAllocation: Number(maxAllocation),
            // Not modelled from this row. Zero is the honest value for "no secondary in this path"
            // and for an assumption nobody has made — never a plausible-looking guess.
            secondaryPps: 0, secondaryCapital: 0, secondaryFeesPct: 0,
            extraDilutionPct: 0, futureDilutionPct: 0,
            exitValue: 0, holdYears: 0, fundSize: 0,
          },
        },
      },
    );
    setBusy(false);
    if (res.status !== 201) {
      setMessage(res.data?.detail ?? res.data?.error ?? `That could not be opened (HTTP ${res.status}).`);
      return;
    }
    setOpenFor(null);
    setMessage(`A follow-on review is open for ${c.company_name}. It is waiting on a partner's decision above.`);
    state.reload();
  }
  const reviews = state.data?.reviews ?? [];
  const candidates = state.data?.candidates ?? [];

  return (
    <div className="page" data-testid="follow-on-page">
      <h3>Follow-on</h3>
      <p className="muted">Where more money might go, and what has already been reviewed.</p>

      {/*
        Said once, here, because four different words were being used for four stages of one path and
        nothing connected them. A partner reading any single surface could not tell how far along a
        company was.
      */}
      <p className="small" data-testid="follow-on-stages">
        A company travels four stages, and each lives somewhere different. <strong>Candidate</strong> — a
        holding whose latest reading beat its previous one, detected below. <strong>Option</strong> — a
        cheque somebody modelled inside an allocation scenario, on Fund strategy.{" "}
        <strong>Review</strong> — the path economics, opened here and decided by a partner.{" "}
        <strong>Booked</strong> — an executed follow-on transaction, which is the only stage where money moved.
      </p>

      <section className="card">
        <h4>
          Open reviews{" "}
          {state.data?.pending_count ? (
            <span className="help-tag help-tag-warn" data-testid="follow-on-pending">{state.data.pending_count} pending</span>
          ) : null}
        </h4>
        {reviews.length === 0 ? (
          <p className="state-empty" data-testid="follow-on-reviews-empty">No follow-on reviews yet.</p>
        ) : (
          <ul className="card-list small" data-testid="follow-on-reviews">
            {reviews.map((r) => (
              <li key={r.id} data-testid={`follow-on-review-${r.id}`}>
                {/* OPEN is the undecided state (migration 0011); "PENDING" is not a value this
                    column can hold, so every review — including ones nobody had looked at — was
                    painted with the good tag. An undecided decision reading as settled is the one
                    thing this list must not do. */}
                <span className={r.status === "OPEN" ? "help-tag help-tag-warn" : "help-tag help-tag-good"}>
                  {r.status.toLowerCase()}
                </span>{" "}
                <strong>{r.company_name ?? r.company_id}</strong>
                {r.reviewed_at && <span className="muted small"> · reviewed {new Date(r.reviewed_at).toLocaleDateString()}</span>}
                {r.review_note && <div className="muted small">{r.review_note}</div>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h4>Pulling ahead</h4>
        <p className="muted small" data-testid="follow-on-rule">{state.data?.candidate_rule}</p>
        {candidates.length === 0 ? (
          <p className="state-empty" data-testid="follow-on-candidates-empty">
            Nothing qualifies. That needs an open position and at least two readings of the same metric.
          </p>
        ) : (
          <ul className="card-list small" data-testid="follow-on-candidates">
            {candidates.map((c) => (
              <li key={`${c.company_id}-${c.metric_key}`} data-testid={`follow-on-candidate-${c.company_id}`}>
                <strong>{c.company_name}</strong>{" "}
                <span className="muted small">
                  {c.metric_key} {c.previous_value} → {c.latest_value} ({pct(c.latest_value, c.previous_value)}) · as of {c.as_of_date}
                </span>
                <div className="form-row">
                  <button
                    type="button"
                    data-testid={`follow-on-open-review-${c.company_id}`}
                    onClick={() => {
                      setOpenFor(openFor === c.company_id ? null : c.company_id);
                      setMessage(null);
                    }}
                  >
                    {openFor === c.company_id ? "Never mind" : "Open a follow-on review"}
                  </button>
                </div>

                {openFor === c.company_id && (
                  <div className="card" data-testid={`follow-on-form-${c.company_id}`}>
                    {/* Said before anything is asked for: what the firm already knows is not
                        retyped, and what it does not know is not guessed. */}
                    <p className="muted small">
                      Against the {Number(c.held_shares ?? 0).toLocaleString()} shares the fund already
                      holds, at a cost of {Number(c.existing_cost ?? 0).toLocaleString()}. Those come
                      from the position; the round is what only you know.
                    </p>
                    <div className="form-row">
                      <label>
                        Scenario
                        <select
                          data-testid={`follow-on-scenario-${c.company_id}`}
                          value={scenarioId}
                          onChange={(e) => setScenarioId(e.target.value)}
                        >
                          <option value="">Choose one</option>
                          {(scenarios.data?.scenarios ?? []).map((sc) => (
                            <option key={sc.id} value={sc.id}>{sc.name}</option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Round size
                        <input data-testid={`follow-on-round-${c.company_id}`} inputMode="decimal" value={roundSize} onChange={(e) => setRoundSize(e.target.value)} />
                      </label>
                      <label>
                        Price per share
                        <input data-testid={`follow-on-pps-${c.company_id}`} inputMode="decimal" value={primaryPps} onChange={(e) => setPrimaryPps(e.target.value)} />
                      </label>
                    </div>
                    <div className="form-row">
                      <label>
                        Ownership you want (%)
                        <input data-testid={`follow-on-target-${c.company_id}`} inputMode="decimal" value={targetPct} onChange={(e) => setTargetPct(e.target.value)} />
                      </label>
                      <label>
                        Most you would put in
                        <input data-testid={`follow-on-max-${c.company_id}`} inputMode="decimal" value={maxAllocation} onChange={(e) => setMaxAllocation(e.target.value)} />
                      </label>
                      <button
                        type="button"
                        className="btn-strong"
                        disabled={!ready || busy}
                        data-testid={`follow-on-submit-${c.company_id}`}
                        onClick={() => void openReview(c)}
                      >
                        Open the review
                      </button>
                    </div>
                    {(scenarios.data?.scenarios ?? []).length === 0 && (
                      <p className="muted small">
                        There is no allocation scenario to open this against yet. One is made on Fund
                        strategy, and a follow-on is always modelled inside one.
                      </p>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {message && <p className="notice small" data-testid="follow-on-message" role="status">{message}</p>}

      <HowThisWorks
        title="Follow-on"
        testId="follow-on"
        what="Follow-on reviews the firm has opened, and companies where a tracked metric has improved since its previous reading."
        when="When deciding where reserve capital goes, or preparing a pro-rata decision."
        operatorDoes={["Read which reviews are pending.", "Look at what is moving and decide whether it warrants a review."]}
        aiDoes={["Nothing decides here. The candidate list is a stated rule over recorded metrics, not a recommendation."]}
        requiresOperator={["Opening a review, and every follow-on decision. Deploying capital is human-reserved."]}
        next="A review carries through the portfolio surface and its approval path. Nothing on this page moves money."
        blocked={["A company only appears under 'pulling ahead' with an open position and two readings of the same metric — with one reading there is nothing to compare."]}
      />
    </div>
  );
}
