import { useState } from "react";
import { api, useApi } from "../lib/api";
// The same words the pipeline uses for the same enum. Sentence-casing the stored value here gave
// "Community intro" on one surface and "Community intro" on the other only by luck; the registry
// is the one place either of them should be reading.
import { originLabel } from "@shared/investment/pipeline";

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

  /*
   * THE SECTION ALWAYS ANNOUNCES ITSELF, in every state.
   *
   * Operator: "the last section is incomplete and not consistent in size heading." Two separate
   * defects, both here. It rendered `<section className="panel">` — a class the stylesheet has no
   * rule for, so it drew no card while every other section on this page did, and its heading sat
   * at a different weight from theirs for no reason a reader could name. And while loading, or on
   * a refusal, it replaced the whole thing — heading included — with the word "Loading…", so the
   * page's last section could vanish entirely and read as something that had failed.
   *
   * Now the heading and the card are drawn first and always, and the state goes inside them, in
   * the same shape as every other section of the record above.
   */
  const d = state.data;
  const recorded = (d?.byOrigin ?? []).filter((r) => r.origin !== "UNRECORDED");
  const community = recorded.filter((r) => COMMUNITY_ORIGINS.has(r.origin));
  const communityDeals = community.reduce((n, r) => n + r.deals, 0);
  const bestLead = community.reduce<number | null>(
    (best, r) => (r.avgLeadDays !== null && (best === null || r.avgLeadDays > best) ? r.avgLeadDays : best),
    null,
  );

  return (
    /* The last band on Dealflow (design/DEALS_SECTION_DESIGN.md §4): the same `.band` shape as the
       bands above it, so the page ends on a section that looks like the others rather than on a
       heading of a different rank. */
    <section className="band">
      <div className="band-head">
        <h3>Where deals come from</h3>
        <span className="band-when">the community is the thesis; this is the proof</span>
      </div>
      <section className="card" data-testid="deal-provenance">
        <p className="muted small">
          Not how busy the community is — how early it puts us in the room. The number that matters
          is how long we knew someone before the deal existed.
        </p>

        {state.loading && <p className="state-empty">Working out where the pipeline came from…</p>}
        {!state.loading && !d && (
          <p className="state-empty">
            This could not be read just now. Nothing is wrong with the deals themselves; reload the
            page and it will try again.
          </p>
        )}

        {d && d.total === 0 && (
          <p className="state-empty">
            There are no deals yet, so there is nothing to trace. Every company added at the top of
            this page is asked where it came from, and the answers gather here.
          </p>
        )}

        {d && d.total > 0 && (
          <>
            {d.unrecordedCount > 0 && (
              <p className="notice notice-gate small" data-testid="provenance-gap">
                <strong>{d.unrecordedCount} of {d.total}</strong> deals have no recorded origin
                {d.unrecordedCount / d.total > 0.4 && " — enough that the rest of this should not be read as a conclusion"}.
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
              /* A wide table scrolls inside its own box rather than pushing the page sideways —
                 the same wrapper every other table in the product uses. */
              <div className="tablewrap">
                <table className="surface-body small">
                  <thead>
                    <tr><th>Where we met them</th><th className="num">Deals</th><th>How long we knew them first</th></tr>
                  </thead>
                  <tbody>
                    {recorded.map((r) => (
                      <tr key={r.origin} data-testid={`origin-${r.origin}`}>
                        <td>{COMMUNITY_ORIGINS.has(r.origin) ? <strong>{originLabel(r.origin)}</strong> : originLabel(r.origin)}</td>
                        <td className="num">{r.deals}</td>
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
              </div>
            )}

            <h4>Set an origin</h4>
            <p className="muted small">
              Where did the relationship start, and roughly when? The date is the useful half — it is
              the difference between meeting someone early and meeting them with everyone else.
            </p>
            <ul className="card-list">
              {d.unrecorded.map((o) => (
                <UnrecordedDeal key={o.id} deal={o} saving={saving === o.id} onSet={setOrigin} />
              ))}
              {d.unrecorded.length === 0 && (
                <li className="state-empty" data-testid="provenance-complete">
                  Every deal on the board says where it came from. Nothing to fill in.
                </li>
              )}
            </ul>
          </>
        )}
      </section>
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
          {ORIGINS.map((o) => <option key={o} value={o}>{originLabel(o)}</option>)}
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
