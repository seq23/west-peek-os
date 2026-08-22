import { useMemo, useState } from "react";
import { api, mutationError, useApi, type MeResponse } from "../lib/api";
import { DEAL_FILTERS, EXITS, SPINE, dealTypeLabel, originLabel, stage, stallRead } from "@shared/investment/pipeline";
import { openOnRegister } from "./CompaniesPage";
// Read from the intake registry rather than retyped: the tags and the mailbox are enforced by the
// email handler, and a page that names them from its own string literal drifts the first time one
// changes and then quietly tells partners the wrong address.
import { DEAL_INTAKE_EMPLOYEE, EMAIL_TRIGGERS, INTAKE_MAILBOX } from "@shared/intake/emailTriggers";

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
  source_channel: string | null;
  arrived_by_email: boolean;
  recommendation: "PASS" | "LOOK_CLOSER" | null;
  recommendation_note: string | null;
  recommended_by: string | null;
  /** Why the firm passed or the deal went away. Required on the way out, so never empty in practice. */
  exit_reason: string | null;
  /** Arrived by email and has not moved since. Derived, so it clears itself the moment it does. */
  unreviewed: boolean;
}

interface Board {
  deals: Deal[];
  counts: Record<string, number>;
  how_staleness_works: string;
}

/** The spine. Filled where deals are, hollow where none. */
function Spine({ counts, onShowExit }: { counts: Record<string, number>; onShowExit: (key: string) => void }) {
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
      {/*
        THE PASS PILE IS A DOOR, NOT A FOOTNOTE.
        Operator: "as long as the pass pile is clearly visible and easy to get to." It was grey text
        under the spine stating a number — you could see that a deal had been passed and had nowhere
        to click. What the firm turned away is one of the more useful things it owns, especially when
        a company comes back raising, so each exit is now the way into its own list.
      */}
      <div className="spine-exits">
        Left the pipeline
        {EXITS.map((e) => (
          <span key={e.key}>
            {" · "}
            <button
              type="button"
              className="link-button"
              data-testid={`spine-exit-${e.key}`}
              onClick={() => onShowExit(e.key)}
            >
              <strong>{counts[e.key] ?? 0}</strong> {e.label.toLowerCase()}
            </button>
          </span>
        ))}
      </div>
    </section>
  );
}

/** One deal. Every card answers the same four things in the same places. */
/*
 * The stages a deal can still be passed on, mirroring OPPORTUNITY_TRANSITIONS on the server.
 *
 * The first version of this offered the pass wherever a deal sat on the spine, which included
 * Invested — the operator caught it. The lifecycle would have refused with a 409, so nothing could
 * have gone wrong; but offering to decline a company the fund already owns is nonsense on its face,
 * and a control that exists only to be refused teaches people to distrust the ones that work.
 *
 * IC_DECIDED is deliberately absent too. Once the committee has ruled, the honest exit is a
 * withdrawal rather than a pass, and the server agrees: it allows only CLOSED or WITHDRAWN there.
 */
const PASSABLE: readonly string[] = ["NEW", "SCREENING", "DILIGENCE", "IC_READY"];

function DealRow({ deal, onChanged, onFixNumbers, onOpenCompany }: {
  deal: Deal;
  onChanged: () => void;
  onFixNumbers: (companyId: string, name: string) => void;
  /** Open this company's own record — its sector, what it does, and everything done to it. */
  onOpenCompany: (companyId: string) => void;
}) {
  const s = stage(deal.status);
  const left = Boolean(s?.isExit);
  const stall = stallRead(deal.status, deal.in_stage_since);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // Forward moves and one backward one. Passing is a decision with a reason attached, which is why
  // it is its own control and not a value in a dropdown that makes it as cheap as a typo — but it
  // has to EXIST, and until 21 Aug 2026 it did not: the lifecycle allowed PASS from every live
  // stage and nothing in the interface could reach it, so the firm could say yes and not no.
  const next = s && s.order !== null ? SPINE.find((x) => (x.order ?? 0) === (s.order ?? 0) + 1) : null;

  async function moveTo(to: string, reason?: string) {
    setBusy(true);
    const res = await api<{ error?: string; detail?: string }>(`/api/opportunities/${deal.id}/transition`, {
      method: "POST",
      body: reason === undefined ? { to } : { to, reason },
    });
    setBusy(false);
    if (res.status !== 200) setMessage(res.data?.detail ?? res.data?.error ?? `Could not move it (HTTP ${res.status}).`);
    else onChanged();
  }

  return (
    <li className={left ? "deal-row deal-row-out" : "deal-row"} data-testid={`deal-${deal.id}`}>
      <div className="deal-company">
        {/*
          THE NAME IS THE WAY TO THE COMPANY. Operator, item 9: a deal and the company it is about
          were two records with nothing joining them on screen — the pipeline printed the name as
          dead text, and getting from "Sensori's deal is stalled" to "what do we actually know about
          Sensori, and who changed it" meant leaving for another page and finding it by eye. The
          name is the obvious thing to click, so it is the thing that works.

          NESTED RATHER THAN BOTH CLASSES ON THE BUTTON. `.link-button` sets `font-size: inherit` at
          a specificity that beats `.deal-name`, so `className="link-button deal-name"` silently
          shrank the most important text on the row to body size. Inside the heading it inherits it.
        */}
        <div className="deal-name">
          <button
            type="button"
            className="link-button"
            data-testid={`deal-company-${deal.id}`}
            title={`Open ${deal.company_name}'s record — what they do, and everything done to it`}
            onClick={() => onOpenCompany(deal.company_id)}
          >
            {deal.company_name}
          </button>
        </div>
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
        {/* WHY IT LEFT, WHERE THE BLOCKER WOULD BE. A deal out of the pipeline has no blocker, and
            this column was showing it where we met them — true, and not the question anybody asks
            about a company the firm declined. The reason was recorded, required, and then never
            shown anywhere, which made every pass in the pile read as a bare "no". */}
        {left ? (
          <>
            <div className="lbl">{deal.status === "WITHDRAWN" ? "Why it went away" : "Why we said no"}</div>
            <div className="deal-blocker-text" data-testid={`deal-exit-reason-${deal.id}`}>
              {deal.exit_reason ?? "No reason was recorded — which is the part that would have been worth keeping."}
            </div>
          </>
        ) : deal.placeholder_fields.length > 0 ? (
          <>
            <div className="lbl">Needs from you</div>
            {/*
              THE WARNING IS THE WAY IN. Operator: "i never realised it was the way to enter real
              numbers for sensori — this is a ui problem." It said a deal was carrying stand-in
              figures and offered no route to the one place they can be replaced, which is further
              down this same page behind a dropdown. Now it takes you there and picks the company.
            */}
            <button
              type="button"
              className="link-button deal-blocker-text warn"
              data-testid={`deal-placeholders-${deal.id}`}
              onClick={() => onFixNumbers(deal.company_id, deal.company_name)}
            >
              {deal.placeholder_fields.length} value{deal.placeholder_fields.length === 1 ? " is a" : "s are"} placeholder
              {deal.placeholder_fields.length === 1 ? "" : "s"} — put the real ones in
            </button>
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
        {/* SAYING NO. Offered on any live deal, because a fund declines far more than it backs and
            the record of what it declined is half the value of the pipeline. The reason is asked
            for, not optional: "we passed in August" is a fact, "we passed because the second
            founder had already left and nobody would say why" is what you want in front of you when
            they come back raising. */}
        {/*
          AN EMPLOYEE'S VIEW, IN FRONT OF THE PARTNER RATHER THAN INSTEAD OF THEM.
          Operator rule: "every arrival survives until i've seen it but it comes with a
          recommendation to scrap it... never scrap our inbound stuff without our input." Letting the
          analyst pass it outright would have been one line of code and would have moved the deal out
          of the funnel — and what leaves the funnel is what you have to remember to go and look for.
          So it stays here, carrying the view and the reason, and the decision is one press either
          way.
        */}
        {deal.recommendation && (
          <div className="deal-recommendation" data-testid={`deal-recommendation-${deal.id}`}>
            <strong>
              {deal.recommended_by ?? "An employee"} says{" "}
              {deal.recommendation === "PASS" ? "pass on this" : "look closer"}.
            </strong>
            {deal.recommendation_note ? <span className="muted"> {deal.recommendation_note}</span> : null}{" "}
            <button
              type="button"
              className="link-button"
              disabled={busy}
              data-testid={`deal-recommendation-clear-${deal.id}`}
              onClick={async () => {
                setBusy(true);
                await api(`/api/opportunities/${deal.id}/recommend`, { method: "POST", body: { recommendation: null } });
                setBusy(false);
                onChanged();
              }}
            >
              keep it, ignore this
            </button>
          </div>
        )}

        {PASSABLE.includes(deal.status) && (
          <button
            type="button"
            className="btn-ghost"
            disabled={busy}
            data-testid={`deal-pass-${deal.id}`}
            onClick={() => {
              const reason = window.prompt(`Why is the firm passing on ${deal.company_name}?`);
              if (reason === null) return;
              if (reason.trim().length < 12) {
                setMessage("Say why in a sentence — a pass with no reason is worth nothing when they come back.");
                return;
              }
              void moveTo("PASS", reason.trim());
            }}
          >
            Pass on this
          </button>
        )}
        {/* REMOVING A RECORD THAT SHOULD NOT EXIST — a duplicate, a typo, the same company entered
            twice. Distinct from a pass, which is a decision about a real company and is kept for
            ever. Offered on every stage, including Invested, because a mistaken row can be created
            at any point; the server refuses if the fund has actually booked a transaction against
            it, which makes it a reversal rather than a correction. */}
        <button
          type="button"
          className="btn-ghost"
          disabled={busy}
          data-testid={`deal-archive-${deal.id}`}
          onClick={async () => {
            const reason = window.prompt(`Why should the record for ${deal.company_name} not exist? (a duplicate, a typo — this is not a pass)`);
            if (reason === null) return;
            if (reason.trim().length < 8) {
              setMessage("Say why in a few words — the reason is the only part that still helps later.");
              return;
            }
            setBusy(true);
            const failed = mutationError(
              await api(`/api/opportunities/${deal.id}/archive`, { method: "POST", body: { reason: reason.trim() } }),
              200,
            );
            setBusy(false);
            setMessage(failed ?? "Off the board. Nothing was destroyed — the record keeps who removed it and why.");
            if (!failed) onChanged();
          }}
        >
          Remove this record
        </button>
        {/* A pass is reversible, and the button says what it costs: the deal comes back at screening
            rather than where it left, because the reason it was passed on has to be looked at again. */}
        {(deal.status === "PASS" || deal.status === "WITHDRAWN") && (
          <button
            type="button"
            className="btn-ghost"
            disabled={busy}
            data-testid={`deal-reopen-${deal.id}`}
            title="Brings it back at screening — the earlier work is not carried forward"
            onClick={() => void moveTo("SCREENING")}
          >
            {busy ? "\u2026" : "Look at it again"}
          </button>
        )}
        {deal.backfilled && <span className="badge" title="Status was entered as history, not decided here">history</span>}

        {/*
          ARRIVED BY EMAIL AND NOBODY HAS LOOKED AT IT.
          Machine-filed deals have to be distinguishable at a glance from ones a partner entered:
          the second kind carries somebody's judgement and the first carries none yet. The badge is
          derived from the deal having never moved off NEW, so it clears itself the moment anybody
          acts — and "Not for us" is right here, because the cost of an emailed junk row is only
          low if dismissing it is one press.
        */}
        {deal.unreviewed && (
          <span className="badge badge-attention" data-testid={`deal-unreviewed-${deal.id}`} title={`Filed from ${deal.source_channel}. Nobody has looked at it yet.`}>
            by email · not yet looked at
          </span>
        )}
      </div>

      {message && <div className="notice small deal-message">{message}</div>}
    </li>
  );
}

export function DealflowPage({
  me,
  onNavigate,
  onFixNumbers,
}: {
  me: MeResponse;
  onNavigate: (key: string) => void;
  /** Take the reader to the deal record with this company already picked. */
  onFixNumbers: (companyId: string, name: string) => void;
}) {
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
  /** Optional. A deal is a record; a deck is an attachment, and one must not block the other. */
  const [deck, setDeck] = useState<File | null>(null);
  /*
   * The sector list, derived from the fund's written mandate on the server and fetched whole.
   * Amending the thesis changes what a company can be filed under, so the two cannot drift — and
   * the derivation lives in one place rather than in every surface that files a company.
   */
  const sectorList = useApi<{ options: Array<{ key: string; label: string; inMandate: boolean }>; from: string }>(
    "/api/thesis/sectors",
  );
  const sectors = sectorList.data?.options ?? [];
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
    /*
     * THE DECK GOES ON WITH THE COMPANY.
     *
     * Operator: "is there a way to add the deck directly from the add a company button flow
     * manually?" There was not, and the missing piece was not the button — a document had nothing
     * recording what it was ABOUT, so an uploaded deck landed on a general shelf with a typed title
     * as its only clue. It is attached in the same call that stores it, because the moment somebody
     * has the deck in their hand is the moment they know whose it is.
     *
     * Attached to the COMPANY rather than the opportunity: a founder's deck outlives any one round,
     * and the next deal in the same company should find it already there.
     *
     * A failed upload does not undo the deal. The company and the opportunity are the record; the
     * deck is an attachment, and losing the file is a thing to say plainly rather than a reason to
     * throw away work that succeeded.
     */
    let deckNote = "";
    if (deck) {
      const bytes = new Uint8Array(await deck.arrayBuffer());
      let binary = "";
      for (const b of bytes) binary += String.fromCharCode(b);
      const up = await api<{ id?: string; error?: string; detail?: string }>("/api/documents", {
        method: "POST",
        body: {
          title: `${name || "Company"} — deck`,
          doc_type: "DECK",
          content_base64: window.btoa(binary),
          content_type: deck.type || "application/octet-stream",
          about: { object_type: "canonical_company", object_id: id, role: "DECK" },
        },
      });
      deckNote = up.status === 201 ? " Deck attached." : ` The deal is in, but the deck did not upload: ${up.data?.detail ?? up.data?.error ?? up.status}.`;
    }

    setMessage(`${company?.canonical_name ?? name} added at ${stage(startsAt)?.label}.${deckNote}`);
    setAdding(false);
    setCompanyId("");
    setDeck(null);
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
          <h3>Top of the funnel</h3>
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
          {/*
            IT WAS NEVER THE ONLY WAY IN, and saying so was worse than saying nothing — a partner
            who believes this is the single door stops looking for the companies that arrived by the
            other three, and does not know to check whether Wyatt has a card waiting. Item 7 asked
            for the routes to be consolidated before any were added; the honest first step is to
            state the ones that already exist and say where each lands.
          */}
          <span className="muted small">the one you drive yourself</span>
        </div>
        <p className="muted small" data-testid="dealflow-other-routes">
          Companies also arrive three other ways, and all three open a work card for {DEAL_INTAKE_EMPLOYEE} rather
          than filing themselves: an email to {INTAKE_MAILBOX} tagged {EMAIL_TRIGGERS.map((t) => t.tag).join(" or ")};
          a company pushed across from Network OS; and {DEAL_INTAKE_EMPLOYEE}'s own scouting. Nothing enters the funnel
          without somebody deciding it should.
        </p>
      </section>

      {/* THE PIPELINE ITSELF, under the door it comes through.

          This sat in a disclosure at the bottom while three stat cards — stalled, waiting on you,
          live — held the top. The cards were counts of the same thing the spine already shows, in
          a shape that says nothing about order or where a deal is stuck. The spine IS the funnel:
          it belongs directly under the mouth, open, and the counts it carries make the cards
          redundant rather than complementary. */}
      <Spine counts={board.data?.counts ?? {}} onShowExit={() => setFilter("PASSED")} />

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
              {/* ITEM 10: the list comes from the thesis, never typed.
                  Sector was free text and had already drifted from the firm's own mandate — the
                  mandate says HEALTH_TECH and the register said "Ed tech" and "Consumer". Three
                  spellings of one taxonomy means "how much of the pipeline is health tech" has no
                  answer. Derived at read time, so amending the thesis changes this and the two can
                  never disagree. */}
              <label>
                Sector{" "}
                <select data-testid="dealflow-new-sector" value={newSector} onChange={(e) => setNewSector(e.target.value)}>
                  <option value="">— not said —</option>
                  {sectors.map((o) => (
                    <option key={o.key} value={o.key}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          {/* The deck, attached to the company as the deal is created — see `create`. Optional, and
              on every path rather than only the new-company one, because a follow-up deck for a
              company already on the board is the more common case. */}
          <label>
            Deck{" "}
            <input
              type="file"
              data-testid="dealflow-deck"
              accept=".pdf,.ppt,.pptx,.key,image/*"
              onChange={(e) => setDeck(e.target.files?.[0] ?? null)}
            />
          </label>

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
          <DealRow
            key={d.id}
            deal={d}
            onChanged={board.reload}
            onFixNumbers={onFixNumbers}
            onOpenCompany={(companyId) => {
              openOnRegister(companyId);
              onNavigate("companies");
            }}
          />
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
