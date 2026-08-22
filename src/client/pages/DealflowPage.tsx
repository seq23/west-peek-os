import { useEffect, useMemo, useState } from "react";
import { api, mutationError, useApi, type MeResponse } from "../lib/api";
import { DEAL_FILTERS, EXITS, SPINE, dealTypeLabel, originLabel, stage, stallRead } from "@shared/investment/pipeline";
import { openOnRegister } from "./CompaniesPage";
import { RecordInvestment } from "./RecordInvestment";
import { DealProvenance } from "./DealProvenance";
// Read from the intake registry rather than retyped: the tags and the mailbox are enforced by the
// email handler, and a page that names them from its own string literal drifts the first time one
// changes and then quietly tells partners the wrong address.
import { DEAL_INTAKE_EMPLOYEE, EMAIL_TRIGGERS, INTAKE_MAILBOX } from "@shared/intake/emailTriggers";

/**
 * Dealflow — where every company stands, and the one record that opens when you pick one.
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
 * ── THE COMPANY RECORD, REBUILT 22 Aug 2026 ─────────────────────────────────────────────────────
 *
 * Operator: "the deal flow tab is still not good enough UI and UX wise. you need to fix it once we
 * pick a company and all the stuff comes out", and before that: "there should be 1 deal record for
 * every company with all fields in it — price per share and # of shares should be in the deal
 * record and it should open once u select a company", and "i dont underestand why it cant be
 * simple like the lp page. everything is there and its easy to follow."
 *
 * WHAT THE OLD RECORD DID. Picking a company revealed a company picker, then a list of deals, then
 * a click to pick one of them, then three unlabelled blocks — one of which was a bare row of
 * inputs with no heading at all. The company's own 360 was rendered twice, once openly and once
 * inside a `<details>` reading "Everything else on record for this company". Price per share and
 * the number of shares existed nowhere on the deal at all: they were only reachable through the
 * transaction ladder, or through a placeholder warning if somebody had happened to mark them.
 *
 * WHAT IT IS NOW. One record per company, opening the moment a company is picked, laid out as a
 * FLAT SEQUENCE of h3 sections in the order a partner actually asks the questions:
 *
 *   1. Where this stands            — stage, how long, what is stopping it, who is carrying it
 *   2. The deal itself              — every field, visible, editable, nothing behind a toggle
 *   3. What we know, and how we know it — the unverified first, because that is the work
 *   4. What is still open           — the questions, and who owes each answer
 *   5. Where this deal stands with the committee — placeholder; see the comment on it
 *   6. Its history                  — every change, attributed
 *   7. Add a second deal            — the ONE thing that nests, because it is the rare case
 *
 * EVERY SECTION ALWAYS RENDERS. A section that disappears when it is empty teaches a reader that
 * the page is unreliable rather than that the fact is absent, so each one states the fact and says
 * what would fill it.
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

/** The deal row as the record reads it — every column the table carries, none of them abbreviated. */
interface DealRecordRow {
  id: string;
  company_id: string;
  opportunity_type: string;
  title: string;
  status: string;
  source_channel: string | null;
  security_class_id: string | null;
  price_per_share: number | null;
  discount_premium: number | null;
  quantity: number | null;
  seller_name: string | null;
  broker_name: string | null;
  fees: number | null;
  carry: number | null;
  relationship_origin: string;
  relationship_started_at: string | null;
  /** A JSON array of field names whose value is a stand-in rather than a fact (migration 0052). */
  placeholder_fields: string;
  placeholder_note: string | null;
  as_of_date: string | null;
  exit_reason: string | null;
  backfilled_at: string | null;
  created_at: string;
}

interface DealMathPacket {
  id: string;
  entry_mode: string;
  math_quality_status: string;
  missing_inputs_json: string;
  source_inputs_json: string;
  valuation: number | null;
  check_size: number | null;
  ownership_at_close: number | null;
  moic: number | null;
  tvpi: number | null;
  created_at: string;
}

interface DealDetail extends DealRecordRow {
  deal_math_packets: DealMathPacket[];
  ic_packets: Array<{ id: string; status: string }>;
}

interface ClaimRow {
  id: string;
  claim_text: string;
  claim_status: string;
  confidence: number;
  created_at: string;
  source_count: number;
}

interface MetricRow {
  metric_key: string;
  value: number;
  as_of_date: string;
  period_label: string | null;
  source: string | null;
}

interface CompanyIntelligence {
  company: { id: string; canonical_name: string; description: string | null };
  claims: ClaimRow[];
  metrics: MetricRow[];
  ownership: { ownership_pct: number | null; fully_diluted_shares: number | null; as_of_date: string; source: string | null } | null;
  known: number;
  unsourced_claims: number;
}

interface OpenQuestion {
  id: string;
  topic: string;
  materiality: string;
  status: string;
  required_question: string | null;
  assigned_owner: string | null;
  created_at: string;
}

interface HistoryEntry {
  id: string;
  at: string;
  by: string;
  what: string;
  said: string | null;
}

/* ── The committee's view of this deal ────────────────────────────────────────────────────────
      Shapes mirror `GET /api/ic/deals/:opportunityId`, which is the same read the Meetings surface
      renders. Two surfaces, one query — they cannot disagree about a deal, which for a decision
      record matters more than either of them being convenient. ─────────────────────────────── */

interface CommitteeQuestion {
  id: string;
  question: string;
  because: string;
  owed_by_kind: string;
  owed_by: string | null;
  state: string;
  answer: string | null;
  withdrawn_reason: string | null;
}

interface CommitteeDeal {
  opportunity_id: string;
  stage: string;
  packet_id: string | null;
  packet_state: string;
  questions: CommitteeQuestion[];
  seats: Array<{ name: string; role: string; decides: boolean }>;
  decision: { id: string; decision: string; rationale: string | null; created_at: string; decided_by: string } | null;
  packet_evidence: {
    assembled_at: string;
    drafted_by: string;
    claims_seen: number;
    claims_unsourced: number;
    contradictions_at_assembly: number;
    contradictions_now: number;
    deal_math_attached: boolean;
  } | null;
  dissents: Array<{ id: string; decision: string; dissenter: string; dissent_text: string; created_at: string }>;
  facilitator_card: { id: string; state: string; title: string } | null;
}

/** Who owes an answer, in words. The stored marker is never printed at a partner. */
function owedInWords(q: CommitteeQuestion): string {
  if (q.owed_by) return q.owed_by;
  switch (q.owed_by_kind) {
    case "PARTNER": return "a partner who is not carrying this deal";
    case "CHAMPION": return "whoever is carrying the deal";
    case "AI_EMPLOYEE": return "an employee";
    case "COUNTERPARTY": return "the company";
    default: return "nobody yet — it has not been given to anybody";
  }
}

/** A work card's state, said rather than shouted. */
function cardStateInWords(state: string): string {
  return state.toLowerCase().split("_").join(" ");
}

/* ── Money, counts and dates are shown the way a person writes them, never the way SQLite stores
      them. `1250000` is not a price and `2026-08-22T09:14:03.221Z` is not a date. ─────────────── */

function money(value: number | null | undefined, currency = "USD"): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    // A share price is pennies-precise; a cheque is not. One formatter, two honest registers.
    maximumFractionDigits: Math.abs(value) < 100 ? 2 : 0,
  }).format(value);
}

function count(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
}

function percent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  // Stored as a fraction in some rows and as a percentage in others; anything at or below 1 is
  // read as a fraction, which is the only reading that makes 0.08 mean eight per cent.
  const pct = Math.abs(value) <= 1 ? value * 100 : value;
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(pct)}%`;
}

function day(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? new Date(t).toLocaleDateString() : "—";
}

/** A label above a value. The record's only repeated shape, so the eye learns it once. */
function Fact({ label, value, note }: { label: string; value: React.ReactNode; note?: React.ReactNode }) {
  return (
    <div className="fact">
      <div className="lbl">{label}</div>
      <div className="fact-value">{value}</div>
      {note ? <div className="fact-note">{note}</div> : null}
    </div>
  );
}

/* ── The vocabulary. Every enum this record touches is translated here, once, so no stored value
      ever reaches the screen. ──────────────────────────────────────────────────────────────── */

/** How much weight a claim carries, and who put it there. */
function claimStanding(status: string): string {
  switch (status) {
    case "VERIFIED":
      return "Checked against a source";
    case "FOUNDER_STATED":
      return "The founder told us";
    case "THIRD_PARTY_SOURCED":
      return "Somebody outside the company said it";
    case "AI_INFERRED":
      return "Worked out by an employee, not confirmed";
    case "MISSING":
      return "Known to be missing";
    default:
      return "Nobody has checked it";
  }
}

/** True where the claim is still work rather than knowledge. */
function isUnchecked(claim: ClaimRow): boolean {
  return claim.source_count === 0 || claim.claim_status === "UNVERIFIED" || claim.claim_status === "AI_INFERRED" || claim.claim_status === "MISSING";
}

function questionWeight(materiality: string): string {
  switch (materiality) {
    case "CRITICAL":
      return "Decides the deal";
    case "HIGH":
      return "Important";
    case "MEDIUM":
      return "Worth resolving";
    default:
      return "Minor";
  }
}

function questionState(status: string): string {
  return status === "INVESTIGATING" ? "somebody is looking into it" : "nobody has started on it";
}

/** How the arithmetic stands, said as a sentence rather than as its stored state. */
function mathStanding(status: string): string {
  switch (status) {
    case "INPUTS_MISSING":
      return "Numbers are still missing";
    case "DRAFT_MATH_COMPLETE":
      return "Worked out, not reviewed";
    case "NEEDS_REVIEW":
      return "Waiting on a second pair of eyes";
    case "IC_READY":
      return "Ready for the committee";
    case "EXCEPTION_MEMO_REQUIRED":
      return "Needs an exception written before it can go further";
    case "REJECTED":
      return "Turned down";
    case "MATH_DOES_NOT_WORK":
      return "The arithmetic does not work";
    default:
      return "Not started";
  }
}

/** What a metric is called out loud. Acronyms stay acronyms; anything else is a phrase. */
const METRIC_WORDS: Record<string, string> = {
  arr: "ARR",
  mrr: "MRR",
  nrr: "Net revenue retention",
  gmv: "GMV",
  cac: "Customer acquisition cost",
  ltv: "Lifetime value",
  burn: "Monthly burn",
  runway: "Runway",
  headcount: "Headcount",
  revenue: "Revenue",
  gross_margin: "Gross margin",
  churn: "Churn",
};

function metricLabel(key: string): string {
  const known = METRIC_WORDS[key.toLowerCase()];
  if (known) return known;
  const words = key.split(/[_\s-]+/).join(" ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * What an event on the spine MEANS, in a sentence.
 *
 * The history endpoint returns the typed event key and the actor, and nothing else about the
 * change except for a company edit, which arrives already written out. Printing the key would be
 * the database talking on the one surface built to stop it, so every key this endpoint can produce
 * is spelled out here and anything unrecognised is turned into a phrase rather than left raw.
 */
const EVENT_WORDS: Record<string, string> = {
  "identity.company_created": "Added to the register",
  "identity.company_merged": "Merged with a duplicate record",
  "identity.company_split": "Split back out of a merge",
  "company.updated": "Company details edited",
  "document.uploaded": "A document was filed",
  "document.linked": "A document was attached to this company",
  "document.version_added": "A newer version of a document arrived",
  "document.archived": "A document was taken off the shelf",
  "investment.opportunity_created": "Deal record opened",
  "investment.opportunity_transitioned": "Moved along the pipeline",
  "investment.opportunity_updated": "Deal terms edited",
  "investment.opportunity_archived": "Deal record taken off the board",
  "investment.opportunity_backfilled": "Entered as history rather than decided here",
  "investment.placeholders_confirmed": "Stand-in figures replaced with real ones",
  "investment.security_class_created": "A share class was recorded",
  "investment.deal_math_packet_created": "The arithmetic was worked out",
  "investment.deal_math_packet_updated": "The arithmetic was changed",
  "investment.deal_math_calculated": "The arithmetic was recomputed with the verified formulas",
  "investment.deal_math_reviewed": "The arithmetic was reviewed",
  "investment.transaction_created": "A purchase was drafted",
  "investment.transaction_submitted": "A purchase was sent for approval",
  "investment.transaction_executed": "A purchase was booked — the fund holds a position",
  "investment.transaction_voided": "A purchase was voided",
  "investment.ownership_snapshot_created": "An ownership reading was recorded",
  "investment.pricing_observation_created": "A price observation was recorded",
  "investment.block_link_proposed": "A possible duplicate deal was flagged",
};

function eventSentence(key: string): string {
  const known = EVENT_WORDS[key];
  if (known) return known;
  const tail = key.includes(".") ? key.slice(key.indexOf(".") + 1) : key;
  const words = tail.split(/[._]+/).join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The stand-in fields, in the words the form uses for them. */
const PLACEHOLDER_WORDS: Record<string, string> = {
  price_per_share: "Price per share",
  quantity: "Number of shares",
  fees: "Fees",
  carry: "Carry",
  discount_premium: "Discount or premium",
  seller_name: "Seller",
  broker_name: "Broker",
};

function placeholderList(json: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(json ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
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

/** One deal on the board. Every row answers the same four things in the same places. */
function DealRow({ deal, open, onChanged, onOpen }: {
  deal: Deal;
  /** True when this deal's company record is the one open below. */
  open: boolean;
  onChanged: () => void;
  /** Open this company's deal record — the whole of it, on this page, below the pipeline. */
  onOpen: (companyId: string, name: string) => void;
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

  const rowClass = ["deal-row", left ? "deal-row-out" : "", open ? "deal-row-open" : ""].filter(Boolean).join(" ");

  return (
    <li className={rowClass} data-testid={`deal-${deal.id}`}>
      <div className="deal-company">
        {/*
          THE NAME OPENS THE RECORD, ON THIS PAGE. Until 22 Aug 2026 it navigated to the company
          register instead — so the answer to "what are this deal's terms" was on a different
          surface from the deal, and the record that holds them opened only after picking the same
          company a second time out of a dropdown further down. One press now opens everything.
        */}
        <div className="deal-name">
          <button
            type="button"
            className="link-button"
            data-testid={`deal-company-${deal.id}`}
            aria-expanded={open}
            title={`Open ${deal.company_name}'s deal record — the terms, what we know, and what is still open`}
            onClick={() => onOpen(deal.company_id, deal.company_name)}
          >
            {deal.company_name}
          </button>
        </div>
        <div className="muted small">{dealTypeLabel(deal.opportunity_type)}</div>
      </div>

      <div className="deal-stage">
        <span className={`stage-chip stage-chip-${deal.status.toLowerCase()}`}>{s?.label ?? "Off the spine"}</span>
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
              figures and offered no route to the one place they can be replaced. Now it opens the
              record, where those fields are the second thing on it.
            */}
            <button
              type="button"
              className="link-button deal-blocker-text warn"
              data-testid={`deal-placeholders-${deal.id}`}
              onClick={() => onOpen(deal.company_id, deal.company_name)}
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
        {/*
          AN EMPLOYEE'S VIEW, IN FRONT OF THE PARTNER RATHER THAN INSTEAD OF THEM.
          Operator rule: "every arrival survives until i've seen it but it comes with a
          recommendation to scrap it... never scrap our inbound stuff without our input." Letting the
          analyst pass it outright would have been one line of code and would have moved the deal out
          of the funnel — and what leaves the funnel is what you have to remember to go and look for.
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
            ever. The server refuses if the fund has actually booked a transaction against it. */}
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
            {busy ? "…" : "Look at it again"}
          </button>
        )}
        {deal.backfilled && <span className="badge" title="Status was entered as history, not decided here">history</span>}

        {/*
          ARRIVED BY EMAIL AND NOBODY HAS LOOKED AT IT. The badge is derived from the deal having
          never moved off NEW, so it clears itself the moment anybody acts.
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

/** The seven numbers the arithmetic runs on, in the order a partner would say them out loud. */
const MATH_FIELDS = [
  ["check_size", "Our cheque"],
  ["round_size", "Size of the round"],
  ["pre_money", "Pre-money valuation"],
  ["exit_value", "What it is worth if it works"],
  ["future_dilution_pct", "Dilution we expect after this (%)"],
  ["hold_years", "Years we expect to hold"],
  ["fund_size", "Size of the fund"],
] as const;

type MathKey = (typeof MATH_FIELDS)[number][0];

const EMPTY_MATH: Record<MathKey, string> = {
  check_size: "",
  round_size: "",
  pre_money: "",
  exit_value: "",
  future_dilution_pct: "",
  hold_years: "",
  fund_size: "",
};

interface TermsForm {
  security_class_id: string;
  price_per_share: string;
  quantity: string;
  fees: string;
  carry: string;
  discount_premium: string;
  seller_name: string;
  broker_name: string;
  relationship_origin: string;
  relationship_started_at: string;
}

const EMPTY_TERMS: TermsForm = {
  security_class_id: "",
  price_per_share: "",
  quantity: "",
  fees: "",
  carry: "",
  discount_premium: "",
  seller_name: "",
  broker_name: "",
  relationship_origin: "UNRECORDED",
  relationship_started_at: "",
};

const ORIGIN_KEYS = [
  "UNRECORDED", "ROOM", "MASTERMIND", "OFFICE", "COUNCIL", "COMMUNITY_INTRO",
  "PORTFOLIO_REFERRAL", "LP_REFERRAL", "INBOUND", "OUTBOUND", "NETWORK", "OTHER",
] as const;

const SECOND_DEAL_KINDS = [
  { key: "FOLLOW_ON", label: "Follow-on — more of a company we already back" },
  { key: "EARLY_STAGE_PRIMARY", label: "Primary — we invest in the company" },
  { key: "SECONDARY_PURCHASE", label: "Secondary — we buy someone else's shares" },
  { key: "SECONDARY_SALE", label: "Secondary — we sell ours" },
  { key: "OTHER", label: "Something else" },
] as const;

/**
 * ONE DEAL RECORD FOR ONE COMPANY, opened by picking the company and nothing else.
 *
 * The order of the sections is the order of the questions. Where does it stand; what are the terms;
 * what do we know and how; what is still unanswered; what has the committee said; what has happened
 * to it; and — nested, because it is rare — is there a second deal to add.
 */
function CompanyDealRecord({
  companyId,
  companyName,
  boardDeals,
  me,
  onChanged,
  onClose,
  onNavigate,
}: {
  companyId: string;
  companyName: string;
  /** The pipeline's own rows for this company: they carry the stage clock, which the deal row does not. */
  boardDeals: Deal[];
  me: MeResponse;
  onChanged: () => void;
  onClose: () => void;
  onNavigate: (key: string) => void;
}) {
  const deals = useApi<{ opportunities: DealRecordRow[] }>(`/api/opportunities?company_id=${companyId}`, [companyId]);
  const [dealId, setDealId] = useState<string | null>(null);
  const detail = useApi<DealDetail>(dealId ? `/api/opportunities/${dealId}` : null, [dealId]);
  const intel = useApi<CompanyIntelligence>(`/api/companies/${companyId}/intelligence`, [companyId]);
  const questions = useApi<{ contradictions: OpenQuestion[] }>(`/api/contradictions?company_id=${companyId}`, [companyId]);
  const history = useApi<{ entries: HistoryEntry[] }>(`/api/companies/${companyId}/history`, [companyId]);
  // The committee's file on THIS deal, keyed on the deal rather than the company: a follow-on and a
  // secondary in the same company go to the committee separately and decide separately.
  const committee = useApi<{ deal: CommitteeDeal | null }>(dealId ? `/api/ic/deals/${dealId}` : null, [dealId]);
  const classes = useApi<{ security_classes: Array<{ id: string; class_name: string }> }>(
    `/api/security-classes?company_id=${companyId}`,
    [companyId],
  );
  const [terms, setTerms] = useState<TermsForm>(EMPTY_TERMS);
  const [math, setMath] = useState<Record<MathKey, string>>(EMPTY_MATH);
  const [packet, setPacket] = useState<DealMathPacket | null>(null);
  const [second, setSecond] = useState({ kind: "FOLLOW_ON", title: "", origin: "UNRECORDED", knownSince: "" });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const rows = deals.data?.opportunities ?? [];
  const d = detail.data && detail.data.id === dealId ? detail.data : null;
  /*
   * NULL UNTIL IT IS THIS DEAL'S ANSWER. `useApi` keeps the previous body while the next request is
   * in flight, so without the id check a reader switching deals would read the outgoing deal's
   * committee record under the incoming deal's name for one frame — and a decision shown against
   * the wrong company is the one mistake this section must never make.
   */
  const committeeDeal =
    committee.data?.deal && committee.data.deal.opportunity_id === dealId ? committee.data.deal : null;

  /*
   * THE RECORD OPENS WITH THE COMPANY, and it opens on the deal that is still live.
   *
   * Operator: "there should be 1 deal record for every company... and it should open once u select
   * a company." A company almost always has exactly one deal that is still moving, so choosing it
   * is not a question worth asking; where there genuinely are several — a follow-on beside a
   * secondary — the chooser appears and nothing is picked for the reader, because then it IS one.
   */
  useEffect(() => {
    setDealId((current) => {
      if (current && rows.some((r) => r.id === current)) return current;
      const live = rows.find((r) => !stage(r.status)?.isExit);
      return (live ?? rows[0])?.id ?? null;
    });
  }, [companyId, rows.length]);

  /*
   * The form is filled from the record ONCE per deal, keyed on its id. Refilling on every reload
   * would overwrite whatever the reader had half-typed the moment anything else on the page
   * refreshed — which is the reason so many editable panels in this product were read-only.
   */
  useEffect(() => {
    if (!d) return;
    setTerms({
      security_class_id: d.security_class_id ?? "",
      price_per_share: d.price_per_share === null ? "" : String(d.price_per_share),
      quantity: d.quantity === null ? "" : String(d.quantity),
      fees: d.fees === null ? "" : String(d.fees),
      carry: d.carry === null ? "" : String(d.carry),
      discount_premium: d.discount_premium === null ? "" : String(d.discount_premium),
      seller_name: d.seller_name ?? "",
      broker_name: d.broker_name ?? "",
      relationship_origin: d.relationship_origin ?? "UNRECORDED",
      relationship_started_at: (d.relationship_started_at ?? "").slice(0, 10),
    });
    const latest = d.deal_math_packets?.[d.deal_math_packets.length - 1] ?? null;
    setPacket(latest);
    const filled = { ...EMPTY_MATH };
    if (latest) {
      try {
        const inputs = JSON.parse(latest.source_inputs_json) as Record<string, unknown>;
        for (const [key] of MATH_FIELDS) {
          const v = inputs[key];
          if (typeof v === "number" || typeof v === "string") filled[key] = String(v);
        }
      } catch {
        // A packet with unreadable inputs is still a packet; the form simply starts empty.
      }
    }
    setMath(filled);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d?.id]);

  const board = boardDeals.find((b) => b.id === dealId) ?? null;
  const s = d ? stage(d.status) : null;
  const stall = d ? stallRead(d.status, board?.in_stage_since ?? d.created_at) : null;
  const provisional = placeholderList(d?.placeholder_fields);
  const securityClasses = classes.data?.security_classes ?? [];
  const instrument = securityClasses.find((c) => c.id === d?.security_class_id)?.class_name ?? null;
  const shares = d?.quantity ?? null;
  const pricePerShare = d?.price_per_share ?? null;
  const amount = shares !== null && pricePerShare !== null ? shares * pricePerShare : null;

  const claims = intel.data?.claims ?? [];
  const unchecked = claims.filter(isUnchecked);
  const checked = claims.filter((c) => !isUnchecked(c));
  const metrics = intel.data?.metrics ?? [];
  const openQuestions = (questions.data?.contradictions ?? []).filter((q) => q.status === "OPEN" || q.status === "INVESTIGATING");
  const entries = history.data?.entries ?? [];
  const missingMath = useMemo(() => {
    if (!packet) return [] as string[];
    try {
      const list = JSON.parse(packet.missing_inputs_json) as unknown;
      return Array.isArray(list) ? list.filter((v): v is string => typeof v === "string") : [];
    } catch {
      return [] as string[];
    }
  }, [packet]);

  /* Who has touched this company most recently, by name. See the note beside the fact itself. */
  const lastTouched = entries[0] ?? null;
  const opened = [...entries].reverse().find((e) => e.what === "investment.opportunity_created") ?? null;

  function reloadAll() {
    deals.reload();
    detail.reload();
    intel.reload();
    questions.reload();
    history.reload();
    classes.reload();
    onChanged();
  }

  /**
   * Saving the terms takes TWO doors on purpose.
   *
   * A field the record itself marks as a stand-in goes through the placeholder door, which is the
   * only one that also clears the mark and works on a deal the fund has already closed — correcting
   * a stand-in is not editing a decision. Everything else goes through the ordinary update.
   */
  async function saveTerms() {
    if (!d) return;
    const numeric: Array<keyof TermsForm> = ["price_per_share", "quantity", "fees", "carry", "discount_premium"];
    const text: Array<keyof TermsForm> = ["seller_name", "broker_name", "security_class_id", "relationship_origin", "relationship_started_at"];
    const patch: Record<string, unknown> = {};
    const placeholders: Record<string, number | string> = {};
    const bad: string[] = [];

    for (const field of numeric) {
      const raw = terms[field].trim();
      const before = d[field as keyof DealRecordRow];
      if (raw === "") {
        if (before !== null && before !== undefined) patch[field] = null;
        continue;
      }
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        bad.push(PLACEHOLDER_WORDS[field] ?? field);
        continue;
      }
      if (value === before) continue;
      if (provisional.includes(field)) placeholders[field] = value;
      else patch[field] = value;
    }
    for (const field of text) {
      const raw = terms[field].trim();
      // The date input holds a plain day and the record may hold a full timestamp. Comparing the
      // two directly makes every save rewrite the same date, which puts a meaningless line on the
      // deal's history each time somebody presses Save.
      const stored = (d[field as keyof DealRecordRow] as string | null) ?? "";
      const before = field === "relationship_started_at" ? stored.slice(0, 10) : stored;
      if (raw === before) continue;
      if (provisional.includes(field)) placeholders[field] = raw;
      else if (raw === "") {
        // Origin has no empty state on the server; UNRECORDED is what "not said" means there.
        if (field !== "relationship_origin") patch[field] = null;
      } else patch[field] = raw;
    }

    if (bad.length > 0) {
      setMessage(`${bad.join(" and ")} has to be a number. Nothing was saved.`);
      return;
    }
    if (Object.keys(patch).length === 0 && Object.keys(placeholders).length === 0) {
      setMessage("Nothing has changed, so nothing was saved.");
      return;
    }

    setBusy(true);
    if (Object.keys(placeholders).length > 0) {
      const failed = mutationError(
        await api(`/api/opportunities/${d.id}/placeholders`, { method: "POST", body: { values: placeholders } }),
        200,
      );
      if (failed) {
        setBusy(false);
        setMessage(failed);
        return;
      }
    }
    if (Object.keys(patch).length > 0) {
      const failed = mutationError(await api(`/api/opportunities/${d.id}`, { method: "PATCH", body: patch }), 200);
      if (failed) {
        setBusy(false);
        setMessage(failed);
        return;
      }
    }
    setBusy(false);
    setMessage("Saved. The change is on the record's history with your name against it.");
    reloadAll();
  }

  /** Work the arithmetic out from typed numbers. Manual entry is always available (D6). */
  async function workOutMath() {
    if (!d) return;
    const missing = MATH_FIELDS.filter(([key]) => math[key].trim() === "" || !Number.isFinite(Number(math[key])));
    if (missing.length > 0) {
      setMessage(`Still needed before the arithmetic means anything: ${missing.map(([, label]) => label.toLowerCase()).join(", ")}.`);
      return;
    }
    setBusy(true);
    const res = await api<DealMathPacket & { error?: string; detail?: string }>(`/api/opportunities/${d.id}/deal-math`, {
      method: "POST",
      body: {
        deal_type: d.opportunity_type,
        source_inputs: Object.fromEntries(MATH_FIELDS.map(([key]) => [key, Number(math[key])])),
      },
    });
    setBusy(false);
    if (res.status !== 201 || !res.data) {
      setMessage(`The arithmetic was refused: ${res.data?.detail ?? res.data?.error ?? `HTTP ${res.status}`}`);
      return;
    }
    setPacket(res.data);
    setMessage("Worked out from the numbers you typed. Nothing here has been reviewed by anybody yet.");
    reloadAll();
  }

  /** Recompute with the formulas that have been hand-verified. Never invents an input. */
  async function calculate() {
    if (!d) return;
    setBusy(true);
    const res = await api<DealMathPacket & { error?: string; detail?: string }>(
      `/api/opportunities/${d.id}/deal-math/calculate`,
      { method: "POST", body: {} },
    );
    setBusy(false);
    if (res.status !== 200 || !res.data) {
      setMessage(`Could not recompute it: ${res.data?.detail ?? res.data?.error ?? `HTTP ${res.status}`}`);
      return;
    }
    setPacket(res.data);
    setMessage("Recomputed with the verified formulas. Anything without one is left as it was typed.");
    reloadAll();
  }

  async function moveTo(to: string, reason?: string) {
    if (!d) return;
    setBusy(true);
    const failed = mutationError(
      await api(`/api/opportunities/${d.id}/transition`, { method: "POST", body: reason === undefined ? { to } : { to, reason } }),
      200,
    );
    setBusy(false);
    setMessage(failed ?? `${companyName} is now at ${(stage(to)?.label ?? "its new stage").toLowerCase()}.`);
    if (!failed) reloadAll();
  }

  async function addSecondDeal(e: React.FormEvent) {
    e.preventDefault();
    if (second.title.trim().length < 2) {
      setMessage("Give the second deal a name you would recognise later — “Series A follow-on” is enough.");
      return;
    }
    setBusy(true);
    const res = await api<{ id?: string; error?: string; detail?: string }>("/api/opportunities", {
      method: "POST",
      body: {
        company_id: companyId,
        opportunity_type: second.kind,
        title: second.title.trim(),
        relationship_origin: second.origin,
        ...(second.knownSince ? { relationship_started_at: second.knownSince } : {}),
      },
    });
    setBusy(false);
    if (res.status !== 201 || !res.data?.id) {
      setMessage(`Not added: ${res.data?.detail ?? res.data?.error ?? `HTTP ${res.status}`}`);
      return;
    }
    setSecond((f) => ({ ...f, title: "", knownSince: "" }));
    setDealId(res.data.id);
    setMessage(`Added. ${companyName} now has ${rows.length + 1} deals, and this record is showing the new one.`);
    reloadAll();
  }

  /** What is actually stopping this deal, in one line, with the detail under it. */
  const blocker = (() => {
    if (!d) return null;
    if (s?.isExit) {
      return {
        value: d.status === "WITHDRAWN" ? "It went away" : "The firm said no",
        note: d.exit_reason ?? "No reason was recorded — which is the part that would have been worth keeping.",
      };
    }
    if (provisional.length > 0) {
      return {
        value: `${provisional.length} figure${provisional.length === 1 ? "" : "s"} still a stand-in`,
        note: `${provisional.map((f) => PLACEHOLDER_WORDS[f] ?? f).join(", ")} — the fields are in the next section.`,
      };
    }
    if (openQuestions.length > 0) {
      return {
        value: `${openQuestions.length} question${openQuestions.length === 1 ? "" : "s"} unanswered`,
        note: openQuestions[0]?.required_question ?? `Two sources disagree about ${openQuestions[0]?.topic ?? "something"}.`,
      };
    }
    if (stall?.stalled) {
      return { value: "Nothing is happening", note: `${stall.label} at ${(s?.label ?? "this stage").toLowerCase()} and nobody has moved it.` };
    }
    return { value: "Nothing", note: s?.question ? `The question at this stage is: ${s.question.toLowerCase()}.` : "It is moving." };
  })();

  const next = s && s.order !== null ? SPINE.find((x) => (x.order ?? 0) === (s.order ?? 0) + 1) : null;

  return (
    <div className="deal-record" data-testid="deal-record">
      {/* ── 1 · WHERE THIS STANDS ──────────────────────────────────────────────────────────── */}
      <h3>Where this stands</h3>
      <section className="card">
        <div className="record-head">
          <h4 data-testid="deal-record-company-name">{companyName}</h4>
          <span className="muted small">
            {d ? `${dealTypeLabel(d.opportunity_type)} · ${d.title}` : "no deal recorded yet"}
          </span>
          <button
            type="button"
            className="link-button"
            data-testid="deal-record-open-register"
            onClick={() => {
              openOnRegister(companyId);
              onNavigate("companies");
            }}
          >
            Its register entry →
          </button>
          <button type="button" className="link-button" data-testid="deal-record-close" onClick={onClose}>
            Close this record
          </button>
        </div>

        {/* A company with more than one deal is a real question, so it is asked. One is not, so it
            is not: the record opens on the live deal without anybody choosing it. */}
        {rows.length > 1 && (
          <div className="record-deals" role="group" aria-label={`Which deal for ${companyName}`}>
            {rows.map((r) => (
              <button
                key={r.id}
                type="button"
                className={r.id === dealId ? "chip chip-on" : "chip"}
                aria-pressed={r.id === dealId}
                data-testid={`deal-record-pick-${r.id}`}
                onClick={() => setDealId(r.id)}
              >
                {r.title} <span className="muted">{stage(r.status)?.label ?? ""}</span>
              </button>
            ))}
          </div>
        )}

        {d ? (
          <>
            <div className="fact-grid" data-testid="deal-record-standing">
              <Fact label="Where it is" value={s?.label ?? "Not on the spine"} note={s?.question} />
              <Fact
                label="In this stage"
                value={stall ? stall.label : "not recorded"}
                note={
                  stall && s?.stallAfterDays
                    ? stall.stalled
                      ? `past the ${s.stallAfterDays} days this stage is given`
                      : `the clock here is ${s.stallAfterDays} days`
                    : "waiting here is not a failure"
                }
              />
              <Fact label="What is stopping it" value={blocker?.value ?? "—"} note={blocker?.note} />
              <Fact
                label="Who is carrying it"
                value={lastTouched?.by ?? opened?.by ?? "Nobody yet"}
                /* Said plainly rather than dressed up: there is no owner field on a deal, so this is
                   the last person who acted on it and the record says so. */
                note={
                  lastTouched
                    ? `no owner is recorded on a deal — this is who last acted on it, ${day(lastTouched.at)}`
                    : "nothing has been done to it since it was added"
                }
              />
            </div>

            <div className="record-actions">
              {next && (
                <button type="button" className="btn-strong" disabled={busy} data-testid="deal-record-advance" onClick={() => void moveTo(next.key)}>
                  {busy ? "…" : `Move to ${next.label.toLowerCase()}`}
                </button>
              )}
              {PASSABLE.includes(d.status) && (
                <button
                  type="button"
                  className="btn-ghost"
                  disabled={busy}
                  data-testid="deal-record-pass"
                  onClick={() => {
                    const reason = window.prompt(`Why is the firm passing on ${companyName}?`);
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
              {(d.status === "PASS" || d.status === "WITHDRAWN") && (
                <button
                  type="button"
                  className="btn-ghost"
                  disabled={busy}
                  data-testid="deal-record-reopen"
                  title="Brings it back at screening — the earlier work is not carried forward"
                  onClick={() => void moveTo("SCREENING")}
                >
                  Look at it again
                </button>
              )}
              {d.backfilled_at && (
                <span className="badge" title="Status was entered as history, not decided here">
                  entered as history
                </span>
              )}
            </div>
          </>
        ) : (
          <p className="state-empty" data-testid="deal-record-none">
            {deals.loading
              ? "Opening the record…"
              : `No deal has been recorded against ${companyName} yet. Everything below is empty for that reason, not because it failed to load — add a deal at the bottom of this record and it will fill in.`}
          </p>
        )}
      </section>

      {/* ── 2 · THE DEAL ITSELF ────────────────────────────────────────────────────────────── */}
      {/*
        THE FIELDS ARE THE POINT AND THEY ARE ALL VISIBLE. Operator: "price per share and # of
        shares should be in the deal record". They were on no surface at all — the only route to
        either was the transaction ladder, which books a position and is a different act from
        recording what a round is priced at. Nothing here is behind a toggle.
      */}
      <h3>The deal itself</h3>
      <section className="card" data-testid="deal-terms">
        {d ? (
          <>
            <p className="muted small record-lede">
              What we would be buying, at what price, and what that adds up to. Every figure is typed
              by a person; anything still a stand-in is marked as one.
            </p>
            <div className="fact-grid">
              <Fact
                label="Instrument"
                value={instrument ?? "Not chosen yet"}
                note={`${dealTypeLabel(d.opportunity_type)}${instrument ? "" : " — pick or add a share class below"}`}
              />
              <Fact
                label="Price per share"
                value={money(pricePerShare)}
                note={provisional.includes("price_per_share") ? <span className="fact-provisional">a stand-in, not a fact</span> : undefined}
              />
              <Fact
                label="Number of shares"
                value={count(shares)}
                note={provisional.includes("quantity") ? <span className="fact-provisional">a stand-in, not a fact</span> : undefined}
              />
              <Fact label="What that costs" value={money(amount)} note={amount === null ? "needs both a price and a share count" : "price per share × number of shares"} />
              <Fact
                label="Ownership at close"
                value={percent(packet?.ownership_at_close)}
                note={packet ? "from the arithmetic below" : "the arithmetic below has not been worked out"}
              />
              <Fact
                label="Valuation"
                value={money(packet?.valuation)}
                note={packet ? "from the arithmetic below" : "the arithmetic below has not been worked out"}
              />
              <Fact label="Terms as of" value={day(d.as_of_date ?? d.created_at)} note={d.as_of_date ? "as entered on the record" : "the day the deal record was opened"} />
              <Fact label="Known since" value={day(d.relationship_started_at)} note={originLabel(d.relationship_origin)} />
              <Fact label="Fees" value={money(d.fees)} />
              <Fact label="Carry" value={money(d.carry)} />
              <Fact label="Discount or premium" value={percent(d.discount_premium)} note="against the last round's price" />
              <Fact label="Seller" value={d.seller_name ?? "—"} note={d.broker_name ? `broker: ${d.broker_name}` : "no broker recorded"} />
            </div>

            {d.placeholder_note && <p className="notice small" data-testid="deal-placeholder-note">{d.placeholder_note}</p>}

            <h4>Put the real numbers in</h4>
            <p className="muted small">
              Saving writes to the deal record and appears in its history with your name against it.
              A figure marked as a stand-in loses the mark the moment you replace it.
            </p>
            <div className="form-row" data-testid="deal-terms-form">
              <label>
                Share class{" "}
                <select
                  data-testid="deal-terms-class"
                  value={terms.security_class_id}
                  onChange={(e) => setTerms((f) => ({ ...f, security_class_id: e.target.value }))}
                >
                  <option value="">— not chosen —</option>
                  {securityClasses.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.class_name}
                    </option>
                  ))}
                </select>
              </label>
              {/* Shares are shares OF something, and a company with no class recorded has nothing
                  to pick. Saying where the class is added beats an empty dropdown with no reason. */}
              {securityClasses.length === 0 && (
                <span className="muted small">No share class is recorded yet — add one further down this section.</span>
              )}
              <label>
                Price per share{" "}
                <input
                  className="input-money"
                  inputMode="decimal"
                  data-testid="deal-terms-price"
                  value={terms.price_per_share}
                  onChange={(e) => setTerms((f) => ({ ...f, price_per_share: e.target.value }))}
                />
              </label>
              <label>
                Number of shares{" "}
                <input
                  className="input-money"
                  inputMode="decimal"
                  data-testid="deal-terms-quantity"
                  value={terms.quantity}
                  onChange={(e) => setTerms((f) => ({ ...f, quantity: e.target.value }))}
                />
              </label>
              <label>
                Fees{" "}
                <input
                  className="input-money"
                  inputMode="decimal"
                  data-testid="deal-terms-fees"
                  value={terms.fees}
                  onChange={(e) => setTerms((f) => ({ ...f, fees: e.target.value }))}
                />
              </label>
              <label>
                Carry{" "}
                <input
                  className="input-money"
                  inputMode="decimal"
                  data-testid="deal-terms-carry"
                  value={terms.carry}
                  onChange={(e) => setTerms((f) => ({ ...f, carry: e.target.value }))}
                />
              </label>
              <label>
                Discount or premium{" "}
                <input
                  className="input-money"
                  inputMode="decimal"
                  data-testid="deal-terms-discount"
                  value={terms.discount_premium}
                  onChange={(e) => setTerms((f) => ({ ...f, discount_premium: e.target.value }))}
                />
              </label>
              <label>
                Seller{" "}
                <input
                  data-testid="deal-terms-seller"
                  value={terms.seller_name}
                  onChange={(e) => setTerms((f) => ({ ...f, seller_name: e.target.value }))}
                />
              </label>
              <label>
                Broker{" "}
                <input
                  data-testid="deal-terms-broker"
                  value={terms.broker_name}
                  onChange={(e) => setTerms((f) => ({ ...f, broker_name: e.target.value }))}
                />
              </label>
              <label>
                How we met them{" "}
                <select
                  data-testid="deal-terms-origin"
                  value={terms.relationship_origin}
                  onChange={(e) => setTerms((f) => ({ ...f, relationship_origin: e.target.value }))}
                >
                  {ORIGIN_KEYS.map((o) => (
                    <option key={o} value={o}>
                      {originLabel(o)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Known since{" "}
                <input
                  type="date"
                  data-testid="deal-terms-known-since"
                  value={terms.relationship_started_at}
                  onChange={(e) => setTerms((f) => ({ ...f, relationship_started_at: e.target.value }))}
                />
              </label>
              <button type="button" className="btn-strong" disabled={busy} data-testid="deal-terms-save" onClick={() => void saveTerms()}>
                Save the deal record
              </button>
            </div>

            {/* THE ARITHMETIC, where the ownership and the valuation above come from. It used to be
                a bare row of inputs with no heading and no sentence saying what pressing anything
                would do. */}
            <h4>The arithmetic behind those two figures</h4>
            <p className="muted small">
              What the cheque buys and what it is worth if it works. Every number is typed by a
              person; nothing here is assumed, and a figure with no verified formula is never
              machine-filled.
            </p>
            <div className="form-row" data-testid="deal-math-inputs">
              {MATH_FIELDS.map(([key, label]) => (
                <label key={key}>
                  {label}{" "}
                  <input
                    className="input-money"
                    inputMode="decimal"
                    data-testid={"deal-math-" + key.split("_").join("-")}
                    value={math[key]}
                    onChange={(e) => setMath((m) => ({ ...m, [key]: e.target.value }))}
                  />
                </label>
              ))}
              <button type="button" className="btn-strong" disabled={busy} data-testid="deal-math-create" onClick={() => void workOutMath()}>
                Work it out
              </button>
              <button type="button" disabled={busy || !packet} data-testid="deal-math-calculate" onClick={() => void calculate()}>
                Recompute with the verified formulas
              </button>
            </div>

            {packet ? (
              <div className="fact-grid" data-testid="deal-math-packet">
                <Fact
                  label="How it was arrived at"
                  value={packet.entry_mode === "CALCULATED" ? "Verified formulas" : "Typed by a person"}
                  note={<span data-testid="deal-math-entry-mode">{packet.entry_mode === "CALCULATED" ? "recomputed, not hand-entered" : "manual entry, which is always allowed"}</span>}
                />
                <Fact label="Where it stands" value={<span data-testid="deal-math-status">{mathStanding(packet.math_quality_status)}</span>} note={day(packet.created_at)} />
                <Fact label="Ownership at close" value={percent(packet.ownership_at_close)} />
                <Fact label="Valuation" value={money(packet.valuation)} />
                <Fact label="Money back on the cheque" value={packet.moic === null ? "—" : `${packet.moic}×`} note="if the exit value above happens" />
                <Fact label="Against the whole fund" value={packet.tvpi === null ? "—" : `${packet.tvpi}×`} note={packet.tvpi === null ? "no verified formula — entered by hand only" : undefined} />
              </div>
            ) : (
              <p className="state-empty" data-testid="deal-math-empty">
                The arithmetic has not been worked out. Fill in the seven numbers above and press
                “Work it out”; until then the ownership and valuation on this record are blank
                because nobody has computed them, not because they are zero.
              </p>
            )}

            {/* THE ONLY WAY A POSITION IS EVER CREATED. Draft, approve, execute — and the fund
                holds nothing until the last of those, whatever the pipeline says. */}
            <RecordInvestment
              companyId={companyId}
              companyName={companyName}
              opportunityId={d.id}
              me={me}
              onRecorded={reloadAll}
            />
          </>
        ) : (
          <p className="state-empty">
            There are no terms because there is no deal. Once one exists, the price per share, the
            number of shares, what that costs, the ownership it buys and the valuation it implies
            are all recorded and edited here.
          </p>
        )}
      </section>

      {/* ── 3 · WHAT WE KNOW, AND HOW WE KNOW IT ───────────────────────────────────────────── */}
      {/*
        RETHOUGHT RATHER THAN MOVED. Operator: "what the firm knows about them / its deals — these
        sections need to be rethought and figure out how to make this easy to work through."

        What was there was a count: "opportunities: 3 · transactions: 0 · positions: 0 · share
        classes: 1 · pricing observations: 0 · IC packets: 1", printed twice on the same screen. A
        tally of rows is not knowledge and there is nothing to work through in it.

        What a partner is actually doing here is separating what somebody CHECKED from what somebody
        SAID. So the unchecked come first, because they are the work, and every line carries how
        many sources stand behind it. The count that leads is the only honest headline: a page of
        claims with no sources should say so before anybody reads one.
      */}
      <h3>What we know, and how we know it</h3>
      <section className="card" data-testid="deal-knowledge">
        <p className="muted small record-lede" data-testid="deal-knowledge-lede">
          {claims.length === 0
            ? `Nothing has been written down about ${companyName} yet.`
            : `${claims.length - unchecked.length} of ${claims.length} thing${claims.length === 1 ? "" : "s"} on record ${claims.length - unchecked.length === 1 ? "has" : "have"} a source behind ${claims.length - unchecked.length === 1 ? "it" : "them"}. The rest is what somebody told us.`}
        </p>

        <h4>Still unchecked — this is the work</h4>
        <ul className="card-list small" data-testid="deal-claims-unchecked">
          {unchecked.map((c) => (
            <li key={c.id} data-testid={`deal-claim-${c.id}`}>
              <strong>{c.claim_text}</strong>
              <div className="muted">
                {claimStanding(c.claim_status)} ·{" "}
                {c.source_count === 0 ? "nothing attached to back it up" : `${c.source_count} source${c.source_count === 1 ? "" : "s"} attached`} ·
                recorded {day(c.created_at)}
              </div>
            </li>
          ))}
          {unchecked.length === 0 && (
            <li className="state-empty">
              {claims.length === 0
                ? `Nothing is on record, so nothing is unchecked. Claims arrive from a meeting, a document, or an employee reading the deck.`
                : `Everything written down about ${companyName} has a source behind it.`}
            </li>
          )}
        </ul>

        <h4>Checked, and where it came from</h4>
        <ul className="card-list small" data-testid="deal-claims-checked">
          {checked.map((c) => (
            <li key={c.id} data-testid={`deal-claim-${c.id}`}>
              <strong>{c.claim_text}</strong>
              <div className="muted">
                {claimStanding(c.claim_status)} · {c.source_count} source{c.source_count === 1 ? "" : "s"} · recorded {day(c.created_at)}
              </div>
            </li>
          ))}
          {checked.length === 0 && (
            <li className="state-empty">
              Nothing has been checked yet. A claim becomes checked when somebody attaches the
              document or the conversation it came from.
            </li>
          )}
        </ul>

        <h4>The numbers we hold</h4>
        <ul className="card-list small" data-testid="deal-metrics">
          {intel.data?.ownership && (
            <li data-testid="deal-ownership-reading">
              <strong>Ownership {percent(intel.data.ownership.ownership_pct)}</strong>
              <div className="muted">
                as of {day(intel.data.ownership.as_of_date)}
                {intel.data.ownership.fully_diluted_shares === null
                  ? ""
                  : ` · ${count(intel.data.ownership.fully_diluted_shares)} shares fully diluted`}
                {intel.data.ownership.source ? ` · ${intel.data.ownership.source}` : ""}
              </div>
            </li>
          )}
          {metrics.map((m) => (
            <li key={`${m.metric_key}-${m.as_of_date}`} data-testid={`deal-metric-${m.metric_key}`}>
              <strong>
                {metricLabel(m.metric_key)} {count(m.value)}
              </strong>
              <div className="muted">
                as of {day(m.as_of_date)}
                {m.period_label ? ` · ${m.period_label}` : ""}
                {m.source ? ` · ${m.source}` : " · no source recorded"}
              </div>
            </li>
          ))}
          {metrics.length === 0 && !intel.data?.ownership && (
            <li className="state-empty">
              No figure has been recorded for {companyName}. They arrive with a portfolio update, or
              are entered by hand against the company on Portfolio.
            </li>
          )}
        </ul>
      </section>

      {/* ── 4 · WHAT IS STILL OPEN ─────────────────────────────────────────────────────────── */}
      <h3>What is still open</h3>
      <section className="card" data-testid="deal-open-questions">
        <p className="muted small record-lede">
          The questions nobody has answered, and who owes each answer. A question appears here when
          two sources disagree, or when somebody raises one in diligence.
        </p>
        <ul className="card-list small">
          {openQuestions.map((q) => (
            <li key={q.id} data-testid={`deal-question-${q.id}`}>
              <strong>{q.required_question ?? `Two sources disagree about ${q.topic}.`}</strong>
              <div className="muted">
                {questionWeight(q.materiality)} · owed by{" "}
                {q.assigned_owner ?? "nobody — it has not been given to anybody"} · {questionState(q.status)} · raised{" "}
                {day(q.created_at)}
              </div>
            </li>
          ))}
          {missingMath.length > 0 && (
            <li data-testid="deal-question-math">
              <strong>The arithmetic is missing {missingMath.length} number{missingMath.length === 1 ? "" : "s"}.</strong>
              <div className="muted">
                Important · owed by whoever is working the deal · the fields are in “The deal itself” above
              </div>
            </li>
          )}
          {openQuestions.length === 0 && missingMath.length === 0 && (
            <li className="state-empty">
              Nothing is outstanding on {companyName}. That is a real answer rather than a gap: no
              contradiction is open and the arithmetic is not missing anything.
            </li>
          )}
        </ul>
      </section>

      {/*
        ── 5 · THE COMMITTEE ───────────────────────────────────────────────────────────────────
        It belongs exactly here: after the open questions, because the committee is what happens once
        they are answered, and before the history, because a decision is a thing that HAS happened
        rather than a thing that is happening.

        WHY THIS IS NOT READ OUT OF `d.ic_packets`. The detail response carries `{ id, status }` per
        packet and nothing else — not the questions, not the seats, not the decision, and above all
        not the dissent. A section built on that would have had to invent the rest on the client,
        and a committee record that disagrees with the committee's own surface is worse than no
        record. `GET /api/ic/deals/:opportunityId` returns the SAME read Meetings renders, so the
        two surfaces cannot drift; `d.ic_packets` is now only how this page knows whether to ask.

        DISSENT IS NOT SUMMARISED, ANYWHERE. It is printed whole, beside the decision it was
        recorded against, and a decision with none says so — because "nobody disagreed" and "nobody
        wrote down that they disagreed" are different facts and only one of them is in the database.
      */}
      <h3>Where this deal stands with the committee</h3>
      <section className="card" data-testid="deal-committee">
        <p className="muted small record-lede">
          What the committee has seen, what it asked for and who owes each answer, who sits in the
          room, what it decided and who disagreed. A deal arrives here by moving to the committee
          stage above — nothing else puts it in front of them.
        </p>

        {committeeDeal === null ? (
          <p className="state-empty" data-testid="deal-committee-none">
            {committee.loading
              ? "Reading the committee's file…"
              : `${companyName} has not been to the committee on this deal. Move it to the committee stage above and a packet opens on its own, with a card for the facilitator to assemble it.`}
          </p>
        ) : (
          <>
            <h4>What the committee has seen</h4>
            <ul className="card-list small" data-testid="deal-committee-packet">
              <li>
                <strong>{committeeDeal.packet_state}</strong>
                <div className="muted">
                  {committeeDeal.stage}
                  {committeeDeal.facilitator_card
                    ? ` · the card to assemble it is ${cardStateInWords(committeeDeal.facilitator_card.state)}`
                    : ""}
                </div>
              </li>
              {committeeDeal.packet_evidence && (
                <li data-testid="deal-committee-evidence">
                  <strong>
                    {count(committeeDeal.packet_evidence.claims_seen)} claim
                    {committeeDeal.packet_evidence.claims_seen === 1 ? "" : "s"} were in front of them
                    {committeeDeal.packet_evidence.claims_unsourced > 0
                      ? `, ${count(committeeDeal.packet_evidence.claims_unsourced)} of them with nothing under them`
                      : ", all of them with a source attached"}
                    .
                  </strong>
                  <div className="muted">
                    Put together by {committeeDeal.packet_evidence.drafted_by} on{" "}
                    {day(committeeDeal.packet_evidence.assembled_at)} ·{" "}
                    {committeeDeal.packet_evidence.deal_math_attached
                      ? "the arithmetic is attached"
                      : "no arithmetic is attached"}
                  </div>
                </li>
              )}
              {committeeDeal.packet_evidence && (
                <li data-testid="deal-committee-contradictions">
                  <strong>
                    {committeeDeal.packet_evidence.contradictions_now === 0
                      ? "The record does not contradict itself in any material place."
                      : `The record contradicts itself in ${count(committeeDeal.packet_evidence.contradictions_now)} material place${committeeDeal.packet_evidence.contradictions_now === 1 ? "" : "s"} right now.`}
                  </strong>
                  {/* THE TWO COUNTS TRAVEL SEPARATELY ON PURPOSE. A contradiction opened after the
                      packet was written is the one nobody in the room knows about. */}
                  <div className="muted">
                    {committeeDeal.packet_evidence.contradictions_at_assembly === 1
                      ? "One was open when the packet was put together"
                      : `${count(committeeDeal.packet_evidence.contradictions_at_assembly)} were open when the packet was put together`}
                    {committeeDeal.packet_evidence.contradictions_now >
                    committeeDeal.packet_evidence.contradictions_at_assembly
                      ? " — the rest were raised since, so nobody in the room has seen them"
                      : ""}
                  </div>
                </li>
              )}
            </ul>

            <h4>What it asked for, and who owes each answer</h4>
            <ul className="card-list small" data-testid="deal-committee-questions">
              {committeeDeal.questions.map((q) => (
                <li key={q.id} className="ic-question" data-testid={`deal-committee-question-${q.id}`}>
                  <span
                    className={
                      q.state === "OPEN"
                        ? "help-tag help-tag-warn"
                        : q.state === "ANSWERED"
                          ? "help-tag help-tag-good"
                          : "help-tag help-tag-muted"
                    }
                  >
                    {q.state === "OPEN" ? "open" : q.state === "ANSWERED" ? "answered" : "not needed"}
                  </span>{" "}
                  <strong>{q.question}</strong>
                  <div className="muted">{q.because}</div>
                  <div className="ic-owes">Owed by {owedInWords(q)}</div>
                  {q.answer && <div className="closeout-quote">{q.answer}</div>}
                  {q.withdrawn_reason && <div className="muted">Not needed because {q.withdrawn_reason}</div>}
                </li>
              ))}
              {committeeDeal.questions.length === 0 && (
                <li className="state-empty">
                  Nothing has been named as missing. A packet with no gaps is either finished or has
                  not been started — the state above says which.
                </li>
              )}
            </ul>

            <h4>Who is in the room</h4>
            <ul className="card-list small" data-testid="deal-committee-seats">
              {committeeDeal.seats.map((s) => (
                <li key={s.name}>
                  <strong>{s.name}</strong> {s.decides && <span className="badge badge-gate">decides</span>}
                  <div className="muted">{s.role}</div>
                </li>
              ))}
              {committeeDeal.seats.length === 0 && (
                <li className="state-empty">
                  Nobody is seated. A committee with no named members is one nobody has agreed to sit on.
                </li>
              )}
            </ul>

            <h4>What it decided</h4>
            <ul className="card-list small" data-testid="deal-committee-decision">
              {committeeDeal.decision ? (
                <li>
                  <strong>{committeeDeal.decision.decision === "APPROVE"
                    ? "The firm is investing."
                    : committeeDeal.decision.decision === "REJECT"
                      ? "The firm passed."
                      : "Not yet — deferred."}</strong>
                  <div className="muted">
                    {committeeDeal.decision.rationale ?? "No reason was written down."}
                  </div>
                  <div className="muted">
                    Recorded by {committeeDeal.decision.decided_by} · {day(committeeDeal.decision.created_at)}
                  </div>
                </li>
              ) : (
                <li className="state-empty">
                  Nothing decided. The decision is made against the packet, by the partners, with an
                  approval receipt behind it — and a pass keeps its reason for good.
                </li>
              )}
            </ul>

            <h4>Who disagreed</h4>
            <ul className="card-list small" data-testid="deal-committee-dissent">
              {committeeDeal.dissents.map((ds) => (
                <li key={ds.id} data-testid={`deal-committee-dissent-${ds.id}`}>
                  <strong>{ds.dissenter} disagreed — {ds.decision.toLowerCase()}</strong>
                  {/* Printed in their own words, never condensed. A committee that records "we
                      agreed" over somebody who did not is wrong about the one thing worth going
                      back for. */}
                  <div className="closeout-quote">{ds.dissent_text}</div>
                  <div className="muted">{day(ds.created_at)}</div>
                </li>
              ))}
              {committeeDeal.dissents.length === 0 && (
                <li className="state-empty">
                  {committeeDeal.decision
                    ? "Nobody recorded a disagreement with this decision. That is not the same as everybody agreeing — it is the same as nobody having written one down, and it can still be added against the decision from Meetings."
                    : "There is no decision to disagree with yet."}
                </li>
              )}
            </ul>

            <button
              type="button"
              className="link-button"
              data-testid="deal-committee-open-meetings"
              onClick={() => onNavigate("meetings")}
            >
              Answer a question, put the packet forward, or record what was decided in Meetings
            </button>
          </>
        )}
      </section>

      {/* ── 6 · ITS HISTORY ────────────────────────────────────────────────────────────────── */}
      <h3>Its history</h3>
      <section className="card" data-testid="deal-history">
        <p className="muted small record-lede">
          Every change to {companyName} and to its deals, most recent first, with whoever made it.
        </p>
        <ul className="card-list small">
          {entries.map((e) => (
            <li key={e.id} data-testid={`deal-history-${e.id}`}>
              <strong>{eventSentence(e.what)}</strong>{" "}
              <span className="muted">
                · {e.by} · {day(e.at)}
              </span>
              {e.said && <div className="muted">{e.said}</div>}
            </li>
          ))}
          {entries.length === 0 && (
            <li className="state-empty">
              {history.loading
                ? "Reading the trail…"
                : `Nothing has been done to ${companyName} since it was added. Every edit, every move along the pipeline and every document filed against it will appear here with a name and a date.`}
            </li>
          )}
        </ul>
      </section>

      {/* ── 7 · A SECOND DEAL ──────────────────────────────────────────────────────────────── */}
      {/*
        THE ONE THING ON THIS RECORD THAT NESTS, and it nests because the operator said it could:
        "yes and the add a second deal to this company part can be neested i guess." A company with
        a follow-on beside a secondary is real and rare; the ordinary case is one deal, and a form
        for the rare case sitting open above the work is what made this page feel like a form rather
        than a record.
      */}
      <h3>Add a second deal to this company</h3>
      <details className="card deal-record-new" data-testid="deal-second-details">
        <summary>Another deal for {companyName} — a follow-on, or a secondary</summary>
        <p className="muted small">
          Only for a second deal in a company already on the board. A company new to the firm goes in
          through “Add a company” at the top of this page.
        </p>
        <form className="form-row" data-testid="deal-second-form" onSubmit={addSecondDeal}>
          <label>
            What kind{" "}
            <select data-testid="deal-second-kind" value={second.kind} onChange={(e) => setSecond((f) => ({ ...f, kind: e.target.value }))}>
              {SECOND_DEAL_KINDS.map((k) => (
                <option key={k.key} value={k.key}>
                  {k.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            What to call it{" "}
            <input
              data-testid="deal-second-title"
              value={second.title}
              onChange={(e) => setSecond((f) => ({ ...f, title: e.target.value }))}
              placeholder="Series A follow-on"
            />
          </label>
          <label>
            How we met them{" "}
            <select data-testid="deal-second-origin" value={second.origin} onChange={(e) => setSecond((f) => ({ ...f, origin: e.target.value }))}>
              {ORIGIN_KEYS.map((o) => (
                <option key={o} value={o}>
                  {originLabel(o)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Known since{" "}
            <input
              type="date"
              data-testid="deal-second-known-since"
              value={second.knownSince}
              onChange={(e) => setSecond((f) => ({ ...f, knownSince: e.target.value }))}
            />
          </label>
          <button type="submit" className="btn-strong" disabled={busy} data-testid="deal-second-submit">
            Add it
          </button>
        </form>
      </details>

      {message && (
        <p className="notice" data-testid="deal-record-message" role="status">
          {message}
        </p>
      )}
    </div>
  );
}

export function DealflowPage({ me, onNavigate }: { me: MeResponse; onNavigate: (key: string) => void }) {
  const board = useApi<Board>("/api/dealflow/board");
  const companies = useApi<{ companies: Array<{ id: string; canonical_name: string }> }>("/api/companies");
  const [adding, setAdding] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [companyId, setCompanyId] = useState("");
  const [startsAt, setStartsAt] = useState("NEW");
  // Blank by default: an invented date is worse than an absent one, and "today" would quietly claim
  // every company was met the day it was filed.
  const [knownSince, setKnownSince] = useState("");
  const [origin, setOrigin] = useState("UNRECORDED");
  // Blank company id means "the name below is new". One form, both cases.
  const [newName, setNewName] = useState("");
  const [newSector, setNewSector] = useState("");
  /** Optional. A deal is a record; a deck is an attachment, and one must not block the other. */
  const [deck, setDeck] = useState<File | null>(null);
  /**
   * WHICH COMPANY'S RECORD IS OPEN. The whole of the second half of this page is this one value.
   *
   * Operator: "you need to fix it once we pick a company and all the stuff comes out." Picking a
   * company used to mean picking it TWICE — once on the pipeline, which navigated away to the
   * register, and again from a dropdown further down, which was the only thing that opened a
   * record. One value, set from either door, and the record is what comes out.
   */
  const [openCompany, setOpenCompany] = useState<{ id: string; name: string } | null>(null);
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
   * and everything.
   */
  const matchesFilter = (dd: Deal, key: string): boolean => {
    const f = DEAL_FILTERS.find((x) => x.key === key);
    if (!f) return true;
    // "Needs you" adds the only condition the stage registry cannot express: how long it has sat.
    if (key === "NEEDS_YOU") return f.matches(dd.status) && Boolean(stallRead(dd.status, dd.in_stage_since)?.stalled);
    return f.matches(dd.status);
  };

  const countFor = (key: string) => deals.filter((dd) => matchesFilter(dd, key)).length;
  const shown = sorted.filter((dd) => matchesFilter(dd, filter));

  /*
   * A RECORD THAT OPENS OFF-SCREEN HAS NOT OPENED.
   *
   * The record sits below the pipeline, and on a full board the row you pressed can be most of a
   * screen above it — so pressing a company appeared to do nothing at all. Done as an effect rather
   * than inside the click handler because the element does not exist until React has rendered the
   * new state; querying for it in the handler finds the previous record, or nothing.
   */
  useEffect(() => {
    if (!openCompany) return;
    document.querySelector('[data-testid="deal-record"]')?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [openCompany?.id]);

  /** Open the record. The scroll is an effect below, once the record actually exists in the page. */
  function openRecord(id: string, name: string) {
    setOpenCompany({ id, name });
  }

  /**
   * THE ONE DOOR INTO THE FUNNEL.
   *
   * There used to be two "Add a company" buttons that did different things, and neither did the
   * whole job. Now this creates whichever half is missing: type a name that is not in the register
   * and it is added; pick one that is and it is reused.
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
        // Sent only when given. An absent date is honest; a default would claim every company was
        // met the day somebody happened to file it, and `DealProvenance` measures lead time from
        // exactly this field.
        ...(knownSince ? { relationship_started_at: knownSince } : {}),
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
     * THE DECK GOES ON WITH THE COMPANY, attached in the same call that stores it, because the
     * moment somebody has the deck in their hand is the moment they know whose it is. Attached to
     * the COMPANY rather than the opportunity: a founder's deck outlives any one round.
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
    // The record for what was just added opens straight away — that is the thing you came to fill in.
    if (id) openRecord(id, name);
  }

  if (board.loading && !board.data) return <p data-testid="dealflow-loading">Loading the pipeline…</p>;

  return (
    <section data-testid="dealflow-page">
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
          <span className="muted small">the one you drive yourself</span>
        </div>
        <p className="muted small" data-testid="dealflow-other-routes">
          Companies also arrive three other ways, and all three open a work card for {DEAL_INTAKE_EMPLOYEE} rather
          than filing themselves: an email to {INTAKE_MAILBOX} tagged {EMAIL_TRIGGERS.map((t) => t.tag).join(" or ")};
          a company pushed across from Network OS; and {DEAL_INTAKE_EMPLOYEE}'s own scouting. Nothing enters the funnel
          without somebody deciding it should.
        </p>
      </section>

      {/* THE PIPELINE ITSELF, under the door it comes through. The spine IS the funnel: it belongs
          directly under the mouth, open, and the counts it carries make a row of stat cards
          redundant rather than complementary. */}
      <Spine counts={board.data?.counts ?? {}} onShowExit={() => setFilter("PASSED")} />

      <p className="muted small" data-testid="dealflow-staleness-note">
        {board.data?.how_staleness_works}
      </p>

      {/* THE PIPELINE, with a way to narrow it. Three companies fit on a screen; thirty do not,
          and "show me what we passed on" is a question this page could not answer at all. */}
      <div className="home-section-head">
        <h3>The pipeline</h3>
        <span className="muted small">sorted by what needs you soonest · press a company to open its record</span>
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
              {/* The list comes from the thesis, never typed. Sector was free text and had already
                  drifted from the firm's own mandate — three spellings of one taxonomy means "how
                  much of the pipeline is health tech" has no answer. */}
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
          {/* The deck, attached to the company as the deal is created — see `create`. */}
          <label>
            Deck{" "}
            <input
              type="file"
              data-testid="dealflow-deck"
              accept=".pdf,.ppt,.pptx,.key,image/*"
              onChange={(e) => setDeck(e.target.files?.[0] ?? null)}
            />
          </label>

          {/* PRIMARY OR SECONDARY. One answer, and everything downstream follows it. */}
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
              {ORIGIN_KEYS.filter((o) => o !== "OFFICE" && o !== "COUNCIL").map((o) => (
                <option key={o} value={o}>{originLabel(o)}</option>
              ))}
            </select>
          </label>
          {/*
            HOW LONG WE HAVE KNOWN THEM, asked at the moment the deal is created.
            
            It was dropped in the rebuild and survived only on the deal's terms or on adding a SECOND
            deal — which turned it into the separate errand this form exists to prevent.
            `DealProvenance` measures lead time from exactly this field, so every deal opened through
            the ordinary door was contributing nothing to the panel sitting underneath it. Asked here,
            beside how we met them, because they are one thought: who introduced us, and how long ago.
          */}
          <label>
            Known since{" "}
            <input
              type="date"
              data-testid="dealflow-known-since"
              value={knownSince}
              onChange={(e) => setKnownSince(e.target.value)}
            />
          </label>
          <button type="submit" className="btn-strong" data-testid="dealflow-add-submit">Add</button>
          <span className="muted small">
            Start it where it already is — everything arriving at “New” makes every clock lie.
            {sleeve !== "EARLY_STAGE_PRIMARY" && " A secondary also appears on the Secondaries page; you do not enter it twice."}
          </span>
        </form>
      )}

      <ul className="deal-list" data-testid="deal-list">
        {shown.map((dd) => (
          <DealRow
            key={dd.id}
            deal={dd}
            open={openCompany?.id === dd.company_id}
            onChanged={board.reload}
            onOpen={openRecord}
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

      {/* THE OTHER DOOR INTO THE RECORD. A company the filter is hiding, or one whose deal was
          archived, still has a record — and a page where the only way in is a row you can see is a
          page that loses companies the moment the list is narrowed. */}
      <div className="deal-record-step" data-testid="deal-record-pick">
        <label>
          <strong>Open a company's deal record</strong>{" "}
          <select
            data-testid="deal-record-company"
            value={openCompany?.id ?? ""}
            onChange={(e) => {
              const picked = (companies.data?.companies ?? []).find((c) => c.id === e.target.value);
              if (picked) openRecord(picked.id, picked.canonical_name);
              else setOpenCompany(null);
            }}
          >
            <option value="">— none open —</option>
            {(companies.data?.companies ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.canonical_name}
              </option>
            ))}
          </select>
        </label>
        <span className="muted small">
          Its terms, what we know, what is still open and everything done to it — all of it, in one
          record, below.
        </span>
      </div>

      {openCompany ? (
        <CompanyDealRecord
          key={openCompany.id}
          companyId={openCompany.id}
          companyName={openCompany.name}
          boardDeals={deals.filter((dd) => dd.company_id === openCompany.id)}
          me={me}
          onChanged={board.reload}
          onClose={() => setOpenCompany(null)}
          onNavigate={onNavigate}
        />
      ) : (
        <p className="state-empty" data-testid="deal-record-closed">
          No company is open. Press a company above, or pick one here, and its whole deal record —
          the terms, the price per share, the shares, what we know and what is still unanswered —
          opens underneath.
        </p>
      )}

      {/* WHERE DEALS COME FROM, kept on the page it is about and given the same section shape as
          everything else. It used to end mid-air with no line saying the queue was empty, which is
          the "last section is incomplete" the operator caught. */}
      <DealProvenance />
    </section>
  );
}
