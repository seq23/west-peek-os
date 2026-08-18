import { useMemo, useState } from "react";
import { api, useApi, type MeResponse } from "../lib/api";
import { EXITS, SPINE, dealTypeLabel, originLabel, stage, stallRead } from "@shared/investment/pipeline";

/**
 * Dealflow — where every company stands, and what is stopping the next decision.
 *
 * WHAT WAS WRONG. The page showed `EARLY_STAGE_PRIMARY` and `SCREENING` in code badges beside
 * "share classes: 0 · pricing observations: 0", and offered "Create deal math packet" and
 * "Assemble IC packet" as its primary actions. Every word of that is the database talking. A
 * partner opening this page is asking one question — what needs me — and nothing on it answered.
 *
 * THE SHAPE IS A LINE, NOT A GRID. A deal only ever moves forward or drops out, so the spine is
 * drawn as one: stages left to right with counts on them, and the two exits hanging below, because
 * a pass is something the pipeline PRODUCES rather than a place anything waits.
 *
 * STALENESS IS THE POINT. Deals die of neglect rather than of judgement, so every row leads with
 * how long it has sat where it is, against that stage's own clock — a week unscreened and a week
 * in diligence are different problems and one global timer would be useless. The clocks live in
 * `shared/investment/pipeline.ts` where they can be argued with.
 *
 * CREATING A DEAL ASKS WHERE IT ALREADY IS. Everything arriving at "New" is how a pipeline fills
 * with companies that were really already in diligence, and then every clock lies.
 */

interface Deal {
  id: string;
  title: string;
  status: string;
  opportunity_type: string;
  relationship_origin: string;
  company_id: string;
  company_name: string;
  created_at: string;
  in_stage_since: string;
  placeholder_fields: string[];
  placeholder_note: string | null;
  backfilled: boolean;
}

interface Board {
  deals: Deal[];
  counts: Record<string, number>;
  how_staleness_works: string;
}

/** The spine. Filled where deals are, hollow where none. */
function Spine({ counts }: { counts: Record<string, number> }) {
  return (
    <section className="card spine" data-testid="dealflow-spine">
      <div className="spine-track">
        {SPINE.map((s, i) => {
          const n = counts[s.key] ?? 0;
          const first = i === 0;
          const last = i === SPINE.length - 1;
          return (
            <div className="spine-stage" key={s.key} data-testid={`spine-${s.key}`}>
              <div className="spine-rail">
                <span className={first ? "spine-line spine-line-end" : "spine-line"} />
                <span className={n > 0 ? "spine-node spine-node-filled" : "spine-node"}>{n}</span>
                <span className={last ? "spine-line spine-line-end" : "spine-line"} />
              </div>
              <div className="spine-label">{s.label}</div>
              <div className="spine-question">{s.question}</div>
            </div>
          );
        })}
      </div>
      <div className="spine-exits">
        Left the pipeline
        {EXITS.map((e) => (
          <span key={e.key}>
            {" · "}
            <strong>{counts[e.key] ?? 0}</strong> {e.label.toLowerCase()}
          </span>
        ))}
      </div>
    </section>
  );
}

/** One deal. Every card answers the same four things in the same places. */
function DealRow({ deal, onChanged }: { deal: Deal; onChanged: () => void }) {
  const s = stage(deal.status);
  const stall = stallRead(deal.status, deal.in_stage_since);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // Only forward moves are offered here. Passing is a decision with a reason attached and belongs
  // on the deal itself, not behind a dropdown that makes it as cheap as a typo.
  const next = s && s.order !== null ? SPINE.find((x) => (x.order ?? 0) === (s.order ?? 0) + 1) : null;

  async function moveTo(to: string) {
    setBusy(true);
    const res = await api<{ error?: string; detail?: string }>(`/api/opportunities/${deal.id}/transition`, {
      method: "POST",
      body: { to },
    });
    setBusy(false);
    if (res.status !== 200) setMessage(res.data?.detail ?? res.data?.error ?? `Could not move it (HTTP ${res.status}).`);
    else onChanged();
  }

  return (
    <li className={deal.status === "PASS" || deal.status === "WITHDRAWN" ? "deal-row deal-row-out" : "deal-row"} data-testid={`deal-${deal.id}`}>
      <div className="deal-company">
        <div className="deal-name">{deal.company_name}</div>
        <div className="muted small">{dealTypeLabel(deal.opportunity_type)}</div>
      </div>

      <div className="deal-stage">
        <span className={`stage-chip stage-chip-${deal.status.toLowerCase()}`}>{s?.label ?? deal.status}</span>
        {stall && (
          <div className={stall.stalled ? "deal-age deal-age-stalled" : "deal-age"} data-testid={`deal-age-${deal.id}`}>
            {stall.label}
            {stall.stalled ? " — stalled" : " here"}
          </div>
        )}
      </div>

      <div className="deal-blocker">
        {deal.placeholder_fields.length > 0 ? (
          <>
            <div className="lbl">Needs from you</div>
            <div className="deal-blocker-text warn">
              {deal.placeholder_fields.length} value{deal.placeholder_fields.length === 1 ? " is a" : "s are"} placeholder
              {deal.placeholder_fields.length === 1 ? "" : "s"}
            </div>
          </>
        ) : stall?.stalled ? (
          <>
            <div className="lbl">Blocked</div>
            <div className="deal-blocker-text">Nothing has happened for {stall.label}</div>
          </>
        ) : (
          <>
            <div className="lbl">Where it came from</div>
            <div className="deal-blocker-text">{originLabel(deal.relationship_origin)}</div>
          </>
        )}
      </div>

      <div className="deal-actions">
        {next && (
          <button
            type="button"
            className="btn-strong"
            disabled={busy}
            data-testid={`deal-advance-${deal.id}`}
            onClick={() => void moveTo(next.key)}
          >
            {busy ? "…" : `Move to ${next.label.toLowerCase()}`}
          </button>
        )}
        {deal.backfilled && <span className="badge" title="Status was entered as history, not decided here">history</span>}
      </div>

      {message && <div className="notice small deal-message">{message}</div>}
    </li>
  );
}

export function DealflowPage({ me, onNavigate }: { me: MeResponse; onNavigate: (key: string) => void }) {
  const board = useApi<Board>("/api/dealflow/board");
  const companies = useApi<{ companies: Array<{ id: string; canonical_name: string }> }>("/api/companies");
  const [adding, setAdding] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [companyId, setCompanyId] = useState("");
  const [startsAt, setStartsAt] = useState("NEW");
  const [origin, setOrigin] = useState("UNRECORDED");

  const deals = board.data?.deals ?? [];

  // Sorted by what needs attention soonest: stalled first, then longest waiting, exits last.
  const sorted = useMemo(() => {
    return [...deals].sort((a, b) => {
      const ax = stage(a.status)?.isExit ? 1 : 0;
      const bx = stage(b.status)?.isExit ? 1 : 0;
      if (ax !== bx) return ax - bx;
      const as = stallRead(a.status, a.in_stage_since);
      const bs = stallRead(b.status, b.in_stage_since);
      if ((bs?.stalled ? 1 : 0) !== (as?.stalled ? 1 : 0)) return (bs?.stalled ? 1 : 0) - (as?.stalled ? 1 : 0);
      return (bs?.days ?? 0) - (as?.days ?? 0);
    });
  }, [deals]);

  const live = deals.filter((d) => !stage(d.status)?.isExit);
  const stalled = live.filter((d) => stallRead(d.status, d.in_stage_since)?.stalled);
  const readyToDecide = live.filter((d) => d.status === "IC_READY");

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!companyId) return;
    const company = companies.data?.companies.find((c) => c.id === companyId);
    const created = await api<{ id?: string; error?: string; detail?: string }>("/api/opportunities", {
      method: "POST",
      body: {
        company_id: companyId,
        opportunity_type: "EARLY_STAGE_PRIMARY",
        title: `${company?.canonical_name ?? "Opportunity"} — ${stage(startsAt)?.label ?? startsAt}`,
        relationship_origin: origin,
      },
    });
    if (created.status !== 201 || !created.data?.id) {
      setMessage(`Not added: ${created.data?.detail ?? created.data?.error ?? created.status}`);
      return;
    }
    // Opportunities are born at NEW. Walk it to where the operator says it already is, so the
    // stage clock starts from a truth rather than from a default.
    if (startsAt !== "NEW") {
      const path = SPINE.filter((s) => (s.order ?? 0) > 1 && (s.order ?? 0) <= (stage(startsAt)?.order ?? 0));
      for (const step of path) {
        const res = await api(`/api/opportunities/${created.data.id}/transition`, { method: "POST", body: { to: step.key } });
        if (res.status !== 200) {
          setMessage(`Added, but could not set it to ${stage(startsAt)?.label}. It is at ${step.label}.`);
          break;
        }
      }
    }
    setMessage(`${company?.canonical_name} added at ${stage(startsAt)?.label}.`);
    setAdding(false);
    setCompanyId("");
    board.reload();
  }

  if (board.loading && !board.data) return <p data-testid="dealflow-loading">Loading the pipeline…</p>;

  return (
    <section data-testid="dealflow-page">
      <p className="muted small">
        Where every company stands, {me.fullName.split(" ")[0]}, and what is stopping the next decision.
      </p>

      <Spine counts={board.data?.counts ?? {}} />

      <div className="pipeline-stats">
        <div className="stat-card stat-card-bad">
          <div className="lbl">Stalled</div>
          <div className="stat-number" data-testid="stat-stalled">{stalled.length}</div>
          <div className="muted small">Sitting longer than the stage allows</div>
        </div>
        <div className="stat-card stat-card-accent">
          <div className="lbl">Waiting on you</div>
          <div className="stat-number" data-testid="stat-ready">{readyToDecide.length}</div>
          <div className="muted small">Everything is in; only a decision is missing</div>
        </div>
        <div className="stat-card">
          <div className="lbl">Live deals</div>
          <div className="stat-number" data-testid="stat-live">{live.length}</div>
          <div className="muted small">Still moving through the pipeline</div>
        </div>
      </div>

      <div className="home-section-head">
        <h2>Every deal</h2>
        <span className="muted small">sorted by what needs you soonest</span>
        <button type="button" className="link-button" data-testid="dealflow-add-toggle" onClick={() => setAdding((a) => !a)}>
          {adding ? "Cancel" : "Add a company"}
        </button>
      </div>

      {message && <p className="notice" data-testid="dealflow-message">{message}</p>}

      {adding && (
        <form className="card form-row" data-testid="dealflow-add-form" onSubmit={create}>
          <label>
            Company{" "}
            <select data-testid="dealflow-company" value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
              <option value="">— select —</option>
              {(companies.data?.companies ?? []).map((c) => (
                <option key={c.id} value={c.id}>{c.canonical_name}</option>
              ))}
            </select>
          </label>
          <label>
            Starts at{" "}
            <select data-testid="dealflow-stage" value={startsAt} onChange={(e) => setStartsAt(e.target.value)}>
              {SPINE.filter((s) => s.key !== "CLOSED").map((s) => (
                <option key={s.key} value={s.key}>{s.label}</option>
              ))}
            </select>
          </label>
          <label>
            How we met them{" "}
            <select data-testid="dealflow-origin" value={origin} onChange={(e) => setOrigin(e.target.value)}>
              {["ROOM", "MASTERMIND", "COMMUNITY_INTRO", "PORTFOLIO_REFERRAL", "LP_REFERRAL", "INBOUND", "OUTBOUND", "NETWORK", "UNRECORDED"].map((o) => (
                <option key={o} value={o}>{originLabel(o)}</option>
              ))}
            </select>
          </label>
          <button type="submit" className="btn-strong" data-testid="dealflow-add-submit">Add</button>
          <span className="muted small">
            Start it where it already is — everything arriving at “New” makes every clock lie.
          </span>
        </form>
      )}

      <ul className="deal-list" data-testid="deal-list">
        {sorted.map((d) => (
          <DealRow key={d.id} deal={d} onChanged={board.reload} />
        ))}
        {sorted.length === 0 && (
          <li className="state-empty" data-testid="dealflow-empty">
            Nothing in the pipeline yet. Add a company above, or capture one as you meet them.
          </li>
        )}
      </ul>

      <p className="muted small" data-testid="dealflow-staleness-note">
        {board.data?.how_staleness_works}
      </p>

      <button type="button" className="link-button" onClick={() => onNavigate("thesis")}>
        What we are looking for →
      </button>
    </section>
  );
}
