import { useMemo, useState } from "react";
import { api, useApi, type MeResponse } from "../lib/api";
import { DEAL_FILTERS, EXITS, SPINE, dealTypeLabel, originLabel, stage, stallRead } from "@shared/investment/pipeline";

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
  // Blank company id means "the name below is new". One form, both cases.
  const [newName, setNewName] = useState("");
  const [newSector, setNewSector] = useState("");
  const [sleeve, setSleeve] = useState("EARLY_STAGE_PRIMARY");
  /**
   * WHERE A DEAL STANDS, as a filter.
   *
   * "Is there a way to filter for passed companies or invested or screening" — no, there was not.
   * The list was everything, always, sorted by urgency, which works at three deals and stops
   * working somewhere around fifteen. Passed deals are the ones most worth being able to isolate:
   * they are the firm's own record of what it declined and why.
   */
  const [filter, setFilter] = useState<string>("LIVE");

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

  /**
   * The filters, and why these five.
   *
   * "Live" is the working default — what is still moving. The rest exist because each answers a
   * question somebody actually arrives with: what needs me, what did we back, what did we pass on,
   * and everything. Passed is the one that was hardest to reach and is the firm's own record of
   * what it declined.
   */
  const matchesFilter = (d: Deal, key: string): boolean => {
    const f = DEAL_FILTERS.find((x) => x.key === key);
    if (!f) return true;
    // "Needs you" adds the only condition the stage registry cannot express: how long it has sat.
    if (key === "NEEDS_YOU") return f.matches(d.status) && Boolean(stallRead(d.status, d.in_stage_since)?.stalled);
    return f.matches(d.status);
  };

  const countFor = (key: string) => deals.filter((d) => matchesFilter(d, key)).length;
  const shown = sorted.filter((d) => matchesFilter(d, filter));

  const live = deals.filter((d) => !stage(d.status)?.isExit);
  const stalled = live.filter((d) => stallRead(d.status, d.in_stage_since)?.stalled);
  const readyToDecide = live.filter((d) => d.status === "IC_READY");

  /**
   * THE ONE DOOR INTO THE FUNNEL.
   *
   * There used to be two "Add a company" buttons that did different things, and neither did the
   * whole job: this one could only pick a company that already existed, and the one on Companies
   * created a company but no deal. So putting a new company into the pipeline meant visiting two
   * pages in the right order, and getting it wrong left either a company with no deal or a deal you
   * could not create.
   *
   * Now this creates whichever half is missing. Type a name that is not in the register and it is
   * added; pick one that is and it is reused.
   */
  async function create(e: React.FormEvent) {
    e.preventDefault();
    let id = companyId;

    // A new name means a new company. Done first, because the deal cannot exist without it.
    if (!id) {
      if (!newName.trim()) return;
      const made = await api<{ id?: string; error?: string; detail?: string }>("/api/companies", {
        method: "POST",
        body: { canonical_name: newName.trim(), ...(newSector.trim() ? { sector: newSector.trim() } : {}) },
      });
      if (made.status !== 201 || !made.data?.id) {
        setMessage(`Could not add ${newName.trim()}: ${made.data?.detail ?? made.data?.error ?? made.status}`);
        return;
      }
      id = made.data.id;
      companies.reload();
    }

    const company = companies.data?.companies.find((c) => c.id === id);
    const name = company?.canonical_name ?? newName.trim();
    const created = await api<{ id?: string; error?: string; detail?: string }>("/api/opportunities", {
      method: "POST",
      body: {
        company_id: id,
        // THE ONE QUESTION THAT ROUTES EVERYTHING DOWNSTREAM. A secondary is a different sleeve
        // with its own approval keys and its own separation rule, and it appears on Secondaries
        // from this answer alone — no second entry anywhere.
        opportunity_type: sleeve,
        title: `${name || "Opportunity"} — ${stage(startsAt)?.label ?? startsAt}`,
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
      {/*
        THE PAGE HAS THREE JOBS AND USED TO ANNOUNCE NONE OF THEM.

        It opened on a line of prose, then the stage spine, then counts, then a heading called
        "Every deal", then the list, then a note about staleness — one continuous scroll with no
        statement of what part of it was for. The operator's words: "I don't know what to prompt you
        to get you to do this right."

        The three jobs, named and in the order you need them:
          1. WHAT WE ARE LOOKING FOR — the thesis. Every screening decision is against it, and it
             lives on another page, so the funnel should point at it rather than assume you hold it
             in your head.
          2. EVERY DEAL — the pipeline itself, and the only door into the firm.
          3. DEAL RECORDS AND TOOLING — the stage spine, the staleness rule, the arithmetic. The
             machinery you consult occasionally, not the thing you came for.
      */}
      {/*
        THE TOP OF THE FUNNEL, and it is the only one.

        Every company the firm has enters here — the operator's instruction, and the reason
        Companies stopped creating records. A door that every deal comes through should not be a
        link-sized control tucked beside a heading, so this is the widest, heaviest thing on the
        page: what we are looking for on one side, the way in on the other.
      */}
      <section className="funnel-mouth" data-testid="dealflow-mouth">
        <div className="funnel-mouth-copy">
          <h2>Top of the funnel</h2>
          <p className="small">
            Every company the firm records enters here, {me.fullName.split(" ")[0]} — primary or
            secondary. Each one is screened against the written mandate, not against instinct,
            which is how a pipeline fills with companies that are interesting and out of scope.
          </p>
          <button type="button" className="link-button" data-testid="dealflow-thesis" onClick={() => onNavigate("thesis")}>
            What we are looking for →
          </button>
        </div>
        <div className="funnel-mouth-action">
          <button type="button" className="btn-strong btn-lg" data-testid="dealflow-add-toggle" onClick={() => setAdding((a) => !a)}>
            {adding ? "Cancel" : "Add a company"}
          </button>
          <span className="muted small">the only way in</span>
        </div>
      </section>

      {/* THE PIPELINE ITSELF, under the door it comes through.

          This sat in a disclosure at the bottom while three stat cards — stalled, waiting on you,
          live — held the top. The cards were counts of the same thing the spine already shows, in
          a shape that says nothing about order or where a deal is stuck. The spine IS the funnel:
          it belongs directly under the mouth, open, and the counts it carries make the cards
          redundant rather than complementary. */}
      <Spine counts={board.data?.counts ?? {}} />

      <p className="muted small" data-testid="dealflow-staleness-note">
        {board.data?.how_staleness_works}
      </p>

      {/* THE PIPELINE, with a way to narrow it. Three companies fit on a screen; thirty do not,
          and "show me what we passed on" is a question this page could not answer at all. */}
      <div className="home-section-head">
        <h3>The pipeline</h3>
        <span className="muted small">sorted by what needs you soonest</span>
        <span className="deal-filters" role="group" aria-label="Filter deals by where they stand">
          {DEAL_FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              className={filter === f.key ? "chip chip-on" : "chip"}
              aria-pressed={filter === f.key}
              data-testid={`dealflow-filter-${f.key}`}
              onClick={() => setFilter(f.key)}
            >
              {f.label} <span className="muted">{countFor(f.key)}</span>
            </button>
          ))}
        </span>
      </div>

      {message && <p className="notice" data-testid="dealflow-message">{message}</p>}

      {adding && (
        <form className="card form-row" data-testid="dealflow-add-form" onSubmit={create}>
          <label>
            Company{" "}
            <select data-testid="dealflow-company" value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
              <option value="">— a company we have not recorded yet —</option>
              {(companies.data?.companies ?? []).map((c) => (
                <option key={c.id} value={c.id}>{c.canonical_name}</option>
              ))}
            </select>
          </label>
          {!companyId && (
            <>
              <label>
                Its name{" "}
                <input
                  data-testid="dealflow-new-name"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Psyflo"
                />
              </label>
              <label>
                Sector{" "}
                <input
                  data-testid="dealflow-new-sector"
                  value={newSector}
                  onChange={(e) => setNewSector(e.target.value)}
                  placeholder="optional"
                />
              </label>
            </>
          )}
          {/* PRIMARY OR SECONDARY. One answer, and everything downstream follows it — the sleeve,
              the approval keys, and whether it shows up on Secondaries. */}
          <label>
            What kind{" "}
            <select data-testid="dealflow-sleeve" value={sleeve} onChange={(e) => setSleeve(e.target.value)}>
              <option value="EARLY_STAGE_PRIMARY">Primary — we invest in the company</option>
              <option value="SECONDARY_PURCHASE">Secondary — we buy someone else's shares</option>
              <option value="SECONDARY_SALE">Secondary — we sell ours</option>
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
            {sleeve !== "EARLY_STAGE_PRIMARY" && " A secondary also appears on the Secondaries page; you do not enter it twice."}
          </span>
        </form>
      )}

      <ul className="deal-list" data-testid="deal-list">
        {shown.map((d) => (
          <DealRow key={d.id} deal={d} onChanged={board.reload} />
        ))}
        {shown.length === 0 && (
          <li className="state-empty" data-testid="dealflow-empty">
            {deals.length === 0
              ? "Nothing in the pipeline yet. Add a company above, or capture one as you meet them."
              : `Nothing is ${DEAL_FILTERS.find((f) => f.key === filter)?.label.toLowerCase()}. The pipeline has ${deals.length} deal${deals.length === 1 ? "" : "s"} in other states.`}
          </li>
        )}
      </ul>

    </section>
  );
}
