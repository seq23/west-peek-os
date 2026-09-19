import { useApi } from "../lib/api";
import { reserveUsd, usd, type ReserveDoc, type SleeveDoc } from "@shared/fund/sleeveMath";

/**
 * WHAT THE RESERVES ARE FOR — Fund strategy's fifth band (design/FUND_STRATEGY_DESIGN.md §3.5).
 *
 * Three figures — held in reserve, drawn by follow-ons, headroom — the rationale the policy carries,
 * and the follow-on REVIEWS the firm has opened. The CANDIDATES ("pulling ahead") are Portfolio's:
 * a company is reviewed from where the company is (`FollowOnCandidates`), and the review then
 * appears here beside the headroom it draws on. Per-company reserves (`position_reserve`) subtract
 * from the headroom once Portfolio writes them.
 */

interface Review {
  id: string; company_id: string; company_name: string | null; status: string;
  reviewed_by: string | null; reviewed_at: string | null; review_note: string | null; created_at: string;
}

function parse<T>(raw: string | undefined | null): T {
  try { return JSON.parse(raw ?? "{}") as T; } catch { return {} as T; }
}

export function ReservesBand({ fundId, onNavigate }: { fundId: string | null; onNavigate?: (key: string) => void }): JSX.Element | null {
  const sleeve = useApi<{ current: { sleeve_json: string } | null }>(fundId ? `/api/funds/${fundId}/policies/sleeve` : null, [fundId]);
  const reserve = useApi<{ current: { reserve_json: string } | null }>(fundId ? `/api/funds/${fundId}/policies/reserve` : null, [fundId]);
  const drawnRows = useApi<{ reserve_allocations: Array<{ amount: number; status?: string }> }>(fundId ? "/api/allocation/reserve-allocations" : null, [fundId]);
  const followOn = useApi<{ reviews: Review[]; pending_count: number }>("/api/follow-on");

  if (!fundId) return null;
  const sleeveDoc = parse<SleeveDoc>(sleeve.data?.current?.sleeve_json);
  const reserveDoc = parse<ReserveDoc & { rationale?: string }>(reserve.data?.current?.reserve_json);
  const held = reserveUsd(sleeveDoc, reserveDoc);
  const drawn = (drawnRows.data?.reserve_allocations ?? []).filter((a) => a.status !== "RELEASED").reduce((sum, a) => sum + (Number(a.amount) || 0), 0);
  const headroom = Math.max(0, held - drawn);
  const reviews = followOn.data?.reviews ?? [];
  const pending = followOn.data?.pending_count ?? 0;

  return (
    <section className="band" data-testid="fund-reserves">
      <div className="band-head">
        <h3>What the reserves are for</h3>
        {pending > 0 && <span className="count-pill" data-testid="fund-reserves-pending">{pending}</span>}
        <span className="band-when">{pending > 0 ? `${pending} review${pending === 1 ? "" : "s"} waiting on a partner` : "held back for the companies already owned"}</span>
      </div>
      <article className="card">
        <dl className="headroom" data-testid="fund-headroom">
          <div className="kv"><b>Held in reserve</b>{usd(held)}</div>
          <div className="kv"><b>Drawn by follow-ons</b>{usd(drawn)}</div>
          <div className="kv"><b>Headroom</b>{usd(headroom)}</div>
        </dl>
        <div className="bar" role="img" aria-label={`${usd(drawn)} of ${usd(held)} drawn`}>
          <i style={{ width: `${held > 0 ? Math.min(100, (drawn / held) * 100) : 0}%` }} />
        </div>
        {reserveDoc.rationale && <p className="muted small" data-testid="fund-reserves-rationale">{reserveDoc.rationale}</p>}

        <div className="section-head"><h4>Follow-on reviews</h4></div>
        {reviews.length === 0 ? (
          <p className="state-empty" data-testid="follow-on-reviews-empty">
            No follow-on review is open. A company earns one from Portfolio's "Which way each company is moving" — pulling ahead is where the next cheque starts.
          </p>
        ) : (
          <ul className="deal-list" data-testid="follow-on-reviews">
            {reviews.map((r) => (
              <li key={r.id} className="deal-row-2" data-testid={`follow-on-review-${r.id}`}>
                <div>
                  <strong>{r.company_name ?? r.company_id}</strong>
                  {r.review_note && <div className="muted small">{r.review_note}</div>}
                </div>
                <span className={r.status === "OPEN" ? "badge-gate" : "badge-ok"}>
                  {r.status === "OPEN" ? "waiting on a partner" : r.status.toLowerCase()}
                  {r.reviewed_at ? ` · ${new Date(r.reviewed_at).toLocaleDateString()}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="actions">
          <button type="button" data-testid="fund-reserves-to-portfolio" onClick={() => onNavigate?.("portfolio")}>Pulling ahead → Portfolio</button>
          <span className="muted small">Per-company reserves subtract from the headroom once they are set on Portfolio.</span>
        </div>
      </article>
    </section>
  );
}
