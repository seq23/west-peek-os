import { useState } from "react";
import { api, useApi } from "../lib/api";

/**
 * Where deals come from (P51, docs/COMMUNITY.md).
 *
 * WHY THIS PANEL EXISTS AND A COMMUNITY DASHBOARD DOES NOT. The community model says in as many
 * words that "the output is not engagement — the output is early inclusion". Members, attendance
 * and engagement rate are therefore the wrong numbers, and building them would have quietly
 * replaced the goal with a proxy that is easier to move.
 *
 * The right number is the lead time: how long we knew someone before the deal existed. Eleven
 * months means the community worked. Six days means we met them the same week as everyone else.
 *
 * TWO DESIGN CHOICES.
 *
 * 1. The unrecorded count sits at the top, not the bottom. If most deals have no provenance the
 *    rest of the table is unreliable, and a reader deserves to know that before they read it.
 *
 * 2. Setting an origin is one dropdown on a row rather than a form on another screen. Provenance
 *    is recoverable from memory for about a week; anything that makes it a separate errand
 *    guarantees it stays UNRECORDED forever.
 */

interface OriginRow {
  origin: string;
  deals: number;
  dated: number;
  avgLeadDays: number | null;
}

interface UnrecordedRow {
  id: string;
  title: string;
  company: string | null;
  created_at: string;
}

const ORIGINS = [
  "ROOM", "MASTERMIND", "OFFICE", "COUNCIL", "COMMUNITY_INTRO",
  "PORTFOLIO_REFERRAL", "LP_REFERRAL", "INBOUND", "OUTBOUND", "NETWORK", "OTHER",
] as const;

/** Community-sourced origins, for the one-line answer to "is this working?". */
const COMMUNITY_ORIGINS = new Set(["ROOM", "MASTERMIND", "OFFICE", "COUNCIL", "COMMUNITY_INTRO"]);

const label = (origin: string): string =>
  origin.charAt(0) + origin.slice(1).toLowerCase().replace(/_/g, " ");

function leadTime(days: number | null): string {
  if (days === null) return "—";
  if (days < 45) return `${days} days`;
  const months = Math.round(days / 30.4);
  return months < 24 ? `${months} months` : `${(months / 12).toFixed(1)} years`;
}

export function DealProvenance(): JSX.Element {
  const state = useApi<{
    byOrigin: OriginRow[];
    total: number;
    unrecordedCount: number;
    unrecorded: UnrecordedRow[];
  }>("/api/opportunities/provenance");

  const [saving, setSaving] = useState<string | null>(null);

  async function setOrigin(id: string, origin: string, startedAt: string | null): Promise<void> {
    setSaving(id);
    await api(`/api/opportunities/${id}`, {
      method: "PATCH",
      body: { relationship_origin: origin, ...(startedAt ? { relationship_started_at: startedAt } : {}) },
    });
    setSaving(null);
    state.reload();
  }

  if (state.loading) return <section className="panel"><p className="muted">Loading…</p></section>;
  const d = state.data;
  if (!d) return <section className="panel"><p className="muted">Could not load provenance.</p></section>;

  const recorded = d.byOrigin.filter((r) => r.origin !== "UNRECORDED");
  const community = recorded.filter((r) => COMMUNITY_ORIGINS.has(r.origin));
  const communityDeals = community.reduce((n, r) => n + r.deals, 0);
  const bestLead = community.reduce<number | null>(
    (best, r) => (r.avgLeadDays !== null && (best === null || r.avgLeadDays > best) ? r.avgLeadDays : best),
    null,
  );

  return (
    <section className="panel" data-testid="deal-provenance">
      <h2>Where deals come from</h2>
      <p className="muted">
        Not how busy the community is — how early it puts us in the room. The number that matters is
        how long we knew someone before the deal existed.
      </p>

      {d.total === 0 ? (
        <p className="muted">No opportunities yet.</p>
      ) : (
        <>
          {d.unrecordedCount > 0 && (
            <p className="warn" data-testid="provenance-gap">
              <strong>{d.unrecordedCount} of {d.total}</strong> deals have no recorded origin
              {d.unrecordedCount / d.total > 0.4 && " — enough that the rest of this table should not be read as a conclusion"}.
              Set them below while someone still remembers.
            </p>
          )}

          {communityDeals > 0 ? (
            <p data-testid="community-verdict">
              <strong>{communityDeals}</strong> deal{communityDeals === 1 ? "" : "s"} trace back to the
              community
              {bestLead !== null && <> — the longest relationship started <strong>{leadTime(bestLead)}</strong> before the deal did</>}.
            </p>
          ) : (
            <p className="muted" data-testid="community-verdict">
              No deal traces back to a Room, a Mastermind or the Council yet. That is expected early;
              if it is still true in eighteen months, the community is not doing the job it exists for.
            </p>
          )}

          {recorded.length > 0 && (
            <table className="data">
              <thead>
                <tr><th>Origin</th><th>Deals</th><th>Average lead time</th></tr>
              </thead>
              <tbody>
                {recorded.map((r) => (
                  <tr key={r.origin} data-testid={`origin-${r.origin}`}>
                    <td>{COMMUNITY_ORIGINS.has(r.origin) ? <strong>{label(r.origin)}</strong> : label(r.origin)}</td>
                    <td>{r.deals}</td>
                    <td>
                      {leadTime(r.avgLeadDays)}
                      {r.dated < r.deals && (
                        <span className="muted"> (from {r.dated} of {r.deals})</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      {d.unrecorded.length > 0 && (
        <>
          <h3>Set an origin</h3>
          <p className="muted">
            Where did the relationship start, and roughly when? The date is the useful half — it is
            the difference between meeting someone early and meeting them with everyone else.
          </p>
          <ul className="card-list">
            {d.unrecorded.map((o) => (
              <UnrecordedDeal key={o.id} deal={o} saving={saving === o.id} onSet={setOrigin} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function UnrecordedDeal(props: {
  deal: UnrecordedRow;
  saving: boolean;
  onSet: (id: string, origin: string, startedAt: string | null) => Promise<void>;
}): JSX.Element {
  const [origin, setOrigin] = useState("");
  const [startedAt, setStartedAt] = useState("");

  return (
    <li className="card" data-testid={`unrecorded-${props.deal.id}`}>
      <div className="card-head-static">
        <span>
          <strong>{props.deal.title}</strong>
          {props.deal.company && <span className="muted"> · {props.deal.company}</span>}
        </span>
        {/* A gap, because the flex row had none and this rendered as
            "Northwind Roboticsentered 2026-08-22". */}
        <span className="muted deal-entered">entered {props.deal.created_at.slice(0, 10)}</span>
      </div>
      <div className="card-body row">
        <select value={origin} onChange={(e) => setOrigin(e.target.value)} aria-label={`Origin for ${props.deal.title}`}>
          <option value="">Where did we meet them…</option>
          {ORIGINS.map((o) => <option key={o} value={o}>{label(o)}</option>)}
        </select>
        <input
          type="date"
          value={startedAt}
          onChange={(e) => setStartedAt(e.target.value)}
          aria-label={`Relationship started for ${props.deal.title}`}
        />
        <button
          type="button"
          disabled={!origin || props.saving}
          onClick={() => props.onSet(props.deal.id, origin, startedAt || null)}
          data-testid={`set-origin-${props.deal.id}`}
        >
          {props.saving ? "Saving…" : "Record"}
        </button>
      </div>
    </li>
  );
}
