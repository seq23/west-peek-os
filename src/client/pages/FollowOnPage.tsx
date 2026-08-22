import { useApi } from "../lib/api";
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
}

function pct(a: number, b: number): string {
  if (!b) return "—";
  return `${(((a - b) / b) * 100).toFixed(0)}%`;
}

export function FollowOnPage(): JSX.Element {
  const state = useApi<{ reviews: Review[]; pending_count: number; candidates: Candidate[]; candidate_rule: string }>("/api/follow-on");
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
                <span className={r.status === "PENDING" ? "help-tag help-tag-warn" : "help-tag help-tag-good"}>
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
              </li>
            ))}
          </ul>
        )}
      </section>

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
