import { useEffect, useMemo, useState } from "react";
import { api, mutationError, useApi, type MeResponse } from "../lib/api";
import { DEAL_FILTERS, EXITS, SPINE, dealTypeLabel, originLabel, stage, stallRead } from "@shared/investment/pipeline";
import { openOnRegister } from "./CompaniesPage";
import { RecordInvestment } from "./RecordInvestment";
import { DealProvenance } from "./DealProvenance";
import { DealPacket } from "./DealPacket";
import { FacePanel, Faces, type Face } from "./Faces";
// Read from the intake registry rather than retyped: the tags and the mailbox are enforced by the
// email handler, and a page that names them from its own string literal drifts the first time one
// changes and then quietly tells partners the wrong address.
import { DEAL_INTAKE_EMPLOYEE, EMAIL_TRIGGERS, INTAKE_MAILBOX } from "@shared/intake/emailTriggers";

/**
 * Dealflow — where every company stands and what is stopping the next decision; the committee
 * lives here now. design/DEALS_SECTION_DESIGN.md §4 (artboards E1, E2), approved 18 Sep 2026.
 *
 * THE RAIL IS THE PAGE. A deal only ever moves forward or drops out, so the pipeline is drawn as
 * one line: six stages left to right with a count on each node, and the two exits on a line
 * beneath, because a pass is something the pipeline PRODUCES rather than a place anything waits.
 * The nodes are buttons that narrow the list. Ink = has companies, orange = the ONE node where a
 * person's act is waiting, green = done — and the words beside the node say the same thing, so
 * colour is never the only cue.
 *
 * THE HUMAN ACT IS THE FIRST BAND. Until this pass nothing on the page said "one thing is waiting
 * on you": a stage move proposed in a meeting (Phase B, `meeting_stage_proposal`) surfaced only on
 * the meeting's After face, and a packet in front of the partners surfaced only on Meetings. Both
 * are now the *Waiting on you* band, above the pipeline, holding the page's one primary button.
 * Accepting a proposal is ONE CLICK (the owner's answer to approval question 2): it is
 * `transitionOpportunity`, already a person's decision, and it does not become a card.
 *
 * STALENESS IS THE POINT. Deals die of neglect rather than of judgement, so every row leads with
 * how long it has sat where it is, against that stage's own clock — a week unscreened and a week
 * in diligence are different problems and one global timer would be useless. The clocks live in
 * `shared/investment/pipeline.ts` where they can be argued with.
 *
 * THE RECORD HAS FIVE FACES. Picking a company opens its record under the pipeline, as one object
 * with five faces — Where this stands · The deal itself · What we know · The committee · History —
 * rather than the seven always-open sections it was (1,100 lines rendered as one scroll). Every
 * face says on its tab what it holds, and a face with nothing in it says so in words. The
 * committee face is section 4 of the old Meetings page, moved here whole: the packet, what it does
 * not know and who owes each answer, who is seated, the decision, and the dissent — and, behind
 * "Open the packet", the packet's own faces (Diligence · Memo · Market · People · Audit), which were
 * the IC Portal's tabs and had been dead-mounted since the Investment page was superseded.
 *
 * NO `window.prompt`. A pass, a removal and a declined proposal each take their reason in an inline
 * field with a visible label and an error slot that reads as an instruction — the prompt had no
 * label, no error, no focus ring and was invisible on a phone keyboard.
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

/** A stage move a meeting proposed and nobody has clicked on yet (`meeting_stage_proposal`, PROPOSED). */
interface Proposal {
  id: string;
  meeting_id: string;
  meeting_title: string;
  meeting_at: string | null;
  opportunity_id: string;
  company_id: string;
  company_name: string;
  from_status: string;
  to_status: string;
  rationale: string;
  proposed_by: string;
  created_at: string;
}

interface Board {
  deals: Deal[];
  counts: Record<string, number>;
  proposals: Proposal[];
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

/* ── The committee's view of a deal ───────────────────────────────────────────────────────────
      Shapes mirror `GET /api/ic/deals` and `GET /api/ic/deals/:opportunityId` — one query, so the
      band and the record's committee face cannot disagree about a deal, which for a decision
      record matters more than either of them being convenient. ──────────────────────────── */

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
  title: string;
  company_name: string | null;
  company_id: string | null;
  stage: string;
  packet_id: string | null;
  packet_state: string;
  questions: CommitteeQuestion[];
  open_question_count: number;
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
  approval_card: { id: string; state: string } | null;
}

/** What the committee face needs of `GET /api/ic/packets/:id/diligence` — the scorecard, not the editor. */
interface DiligenceSummary {
  packet: { id: string; champion_user_id: string | null };
  framework: {
    core: Array<{ id: string; title: string }>;
    sector: { sector: string; title: string } | null;
    closing_six: Array<{ n: number; question: string; championMayNotAnswer?: boolean }>;
  };
  answers: Array<{ section_id: string; state: string }>;
  readiness: { open: string[]; complete: boolean; bear_case_missing: boolean };
  restricted_section_ids: string[];
}

interface CommitteeSurface {
  deals: CommitteeDeal[];
  facilitator: { name: string; status: string } | null;
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

function whenInWords(iso: string | null | undefined): string {
  if (!iso) return "no time recorded";
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? new Date(t).toLocaleString() : "no time recorded";
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

/**
 * The stages the firm is ACTING in. One chip carries orange — `.stage-chip-live` — and it is the
 * stage where the firm's own work happens: screening, diligence, the decision. New is arrival and
 * Decided is paperwork; neither is a status that earns a colour. Invested is green because it is
 * done. `.stage-chip-screening/-diligence/-ic_ready` painted three stages orange, which made orange
 * a status — against §2 of the design system — and they are retired.
 */
const LIVE_STAGES: readonly string[] = ["SCREENING", "DILIGENCE", "IC_READY"];

/** What the stage clock says on a row: how long here, and the clock it is running against. */
function clockInWords(status: string, since: string): { text: string; stalled: boolean } | null {
  const s = stage(status);
  const stall = stallRead(status, since);
  if (!s || !stall) return null;
  if (s.isExit) return { text: `left ${day(since)}`, stalled: false };
  if (stall.stalled) return { text: `${stall.label} — stalled`, stalled: true };
  if (s.stallAfterDays === null) return { text: `${stall.label} here`, stalled: false };
  return { text: `${stall.label} here · clock is ${s.stallAfterDays}`, stalled: false };
}

/* ── An inline reason field ──────────────────────────────────────────────────────────────────
      The replacement for `window.prompt()`: a visible label, a helper line that becomes the error
      in place (the slot reserves a line, so nothing shifts), the global focus ring, and a phone
      keyboard that can actually reach it. The error is written as an instruction. ─────────── */

function ReasonField({
  id,
  label,
  help,
  minLength,
  tooShort,
  confirmLabel,
  confirmClass,
  busy,
  onConfirm,
  onCancel,
  testId,
}: {
  id: string;
  label: string;
  help: string;
  minLength: number;
  /** The instruction shown when the reason is too thin — never "invalid". */
  tooShort: string;
  confirmLabel: string;
  confirmClass: string;
  busy: boolean;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
  testId: string;
}): JSX.Element {
  const [value, setValue] = useState("");
  const [err, setErr] = useState<string | null>(null);

  function confirm() {
    if (value.trim().length < minLength) {
      setErr(tooShort);
      return;
    }
    onConfirm(value.trim());
  }

  return (
    <div className="stack" data-testid={testId}>
      <label className="field" htmlFor={id}>
        {label}
        <input
          id={id}
          data-testid={`${testId}-text`}
          value={value}
          autoFocus
          aria-invalid={err ? true : undefined}
          aria-describedby={`${id}-help`}
          onChange={(e) => {
            setValue(e.target.value);
            if (err) setErr(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              confirm();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            }
          }}
        />
        <span id={`${id}-help`} className={err ? "field-help err" : "field-help"} role={err ? "alert" : undefined}>
          {err ?? help}
        </span>
      </label>
      <div className="row">
        <button type="button" className={confirmClass} disabled={busy} aria-busy={busy || undefined} data-testid={`${testId}-confirm`} onClick={confirm}>
          {busy ? "…" : confirmLabel}
        </button>
        <button type="button" className="btn-ghost" disabled={busy} data-testid={`${testId}-cancel`} onClick={onCancel}>
          Never mind
        </button>
      </div>
    </div>
  );
}

/* ── The stage rail ──────────────────────────────────────────────────────────────────────────
      The pipeline drawn as a line. Nodes are BUTTONS that narrow the list; the exits line carries
      Phase A's rule — every company enters at New, however it arrived — and the two exits as the
      doors into their own lists. ────────────────────────────────────────────────────────────── */

function StageRail({
  counts,
  actStage,
  filter,
  onFilter,
}: {
  counts: Record<string, number>;
  /** The one stage where a person's act is waiting, if any. Orange, and said in words. */
  actStage: string | null;
  filter: string;
  onFilter: (key: string) => void;
}): JSX.Element {
  return (
    <section className="card" data-testid="stage-rail">
      <ul className="stage-rail" aria-label="The pipeline, left to right">
        {SPINE.map((s) => {
          const n = counts[s.key] ?? 0;
          const isAct = actStage === s.key;
          const done = s.key === "CLOSED" && n > 0;
          const cls = ["stage-node", isAct ? "stage-node-current" : done ? "stage-node-done" : n > 0 ? "stage-node-filled" : ""]
            .filter(Boolean)
            .join(" ");
          const pressed = filter === `stage:${s.key}`;
          return (
            <li key={s.key}>
              <div className="stage-rail-line">
                <i />
                <button
                  type="button"
                  className={cls}
                  aria-label={`${s.label}, ${n === 0 ? "none" : `${n} compan${n === 1 ? "y" : "ies"}`}${isAct ? " — the act is here" : ""}`}
                  aria-pressed={pressed}
                  data-testid={`stage-node-${s.key}`}
                  onClick={() => onFilter(pressed ? "LIVE" : `stage:${s.key}`)}
                >
                  {n}
                </button>
                <i />
              </div>
              <span className="stage-label">{s.label}</span>
              <span className="stage-q">
                {s.question}
                {s.stallAfterDays !== null ? ` · ${s.stallAfterDays} days` : ""}
                {isAct ? " · the act is here" : ""}
              </span>
            </li>
          );
        })}
      </ul>
      {/*
        THE PASS PILE IS A DOOR, NOT A FOOTNOTE. Operator: "as long as the pass pile is clearly
        visible and easy to get to." What the firm turned away is one of the more useful things it
        owns, especially when a company comes back raising, so each exit is the way into its list.
        The sentence after them is Phase A's rule, stated once, where the rail ends.
      */}
      <p className="stage-rail-exits" data-testid="stage-rail-exits">
        Left the pipeline
        {EXITS.map((e) => (
          <span key={e.key}>
            {" · "}
            <button type="button" className="link-button" data-testid={`stage-exit-${e.key}`} aria-pressed={filter === "PASSED"} onClick={() => onFilter("PASSED")}>
              <strong>{counts[e.key] ?? 0}</strong> {e.label.toLowerCase()}
            </button>
          </span>
        ))}
        {" · "}every company the firm records enters at New, however it arrived
      </p>
    </section>
  );
}

/** The compact rail on the record head. Never interactive; the stage word carries the meaning. */
function CompactRail({ status, since, name }: { status: string; since: string | null; name: string }): JSX.Element {
  const s = stage(status);
  const here = s?.order ?? null;
  const exit = Boolean(s?.isExit);
  const stall = stallRead(status, since);
  return (
    <ul className="stage-rail-compact" aria-label={`Where ${name} is`}>
      {SPINE.map((x, i) => {
        const order = x.order ?? 0;
        const current = !exit && here === order;
        const done = !exit && here !== null && order < here;
        const closed = x.key === "CLOSED" && status === "CLOSED";
        const dot = ["stage-dot", closed ? "stage-dot-closed" : current ? "stage-dot-current" : done ? "stage-dot-done" : ""].filter(Boolean).join(" ");
        return (
          <li key={x.key}>
            <span className={dot} aria-hidden="true" />
            {current ? (
              <strong className="small">
                {x.label}
                {stall ? ` · ${stall.label}` : ""}
              </strong>
            ) : (
              <span className="small muted">{x.label}</span>
            )}
            {i < SPINE.length - 1 && <span className="stage-seg" aria-hidden="true" />}
          </li>
        );
      })}
      {exit && (
        <li>
          <span className="stage-dot stage-dot-done" aria-hidden="true" />
          <strong className="small">{s?.label}</strong>
        </li>
      )}
    </ul>
  );
}

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
  const clock = clockInWords(deal.status, deal.in_stage_since);
  const stalled = Boolean(clock?.stalled);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  /** Which inline reason field is open on this row, if any. */
  const [asking, setAsking] = useState<"pass" | "remove" | null>(null);

  /*
   * A MOVE IS NOT OVER WHEN THE REQUEST RETURNS — IT IS OVER WHEN THE ROW SAYS SO.
   *
   * `moveTo` awaited the transition, cleared `busy`, then called `onChanged()`, which is
   * `board.reload` — a fire-and-forget refetch that cannot be awaited. For the width of that refetch
   * the row was re-enabled while still rendering the OLD stage, so the "Move to …" button on screen
   * was offering the move that had just been made. Pressing it sent the firm's own pipeline a
   * transition to the stage the deal was already in: a request the server correctly refuses, a press
   * a partner made in good faith, and NOTHING on the page to say the press was thrown away.
   *
   * CONFIRMED 18 Sep 2026 by `p57-deal-intake-and-pipeline` — "a deal is walked the whole length of
   * the pipeline" failed with `Expected: "CLOSED" / Received: "IC_DECIDED"`, because one press in
   * the walk landed on a button that had not caught up. Under load that window is wide enough to
   * hit; on an idle laptop it usually is not. The defect is the same either way.
   *
   * So the row stays busy until the STAGE IT IS RENDERING has actually changed. `movedFrom` is the
   * status the press was made against; while the row is still showing that status, the move is
   * still in flight and no second press is offered. It clears on any change, not only on the
   * expected one, so a transition the server resolved differently can never wedge the control.
   */
  const [movedFrom, setMovedFrom] = useState<string | null>(null);
  const settling = movedFrom !== null && deal.status === movedFrom;
  useEffect(() => {
    if (movedFrom !== null && deal.status !== movedFrom) setMovedFrom(null);
  }, [deal.status, movedFrom]);

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
    else {
      setMovedFrom(deal.status);
      setAsking(null);
      onChanged();
    }
  }

  const rowClass = ["deal-row", left ? "deal-row-out" : "", open ? "deal-row-selected" : ""].filter(Boolean).join(" ");

  return (
    <li className={rowClass} data-testid={`deal-${deal.id}`}>
      <div className="deal-company">
        {/*
          THE NAME OPENS THE RECORD, ON THIS PAGE. Until 22 Aug 2026 it navigated to the company
          register instead — so the answer to "what are this deal's terms" was on a different
          surface from the deal, and the record that holds them opened only after picking the same
          company a second time out of a dropdown further down. One press now opens everything;
          the dropdown is gone, because the row's name is the door.
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
        <div className="deal-sub">
          {dealTypeLabel(deal.opportunity_type)}
          {deal.backfilled && (
            <>
              {" · "}
              <span className="badge" title="Status was entered as history, not decided here">history</span>
            </>
          )}
          {/*
            ARRIVED BY EMAIL AND NOBODY HAS LOOKED AT IT. The badge is derived from the deal having
            never moved off NEW, so it clears itself the moment anybody acts.
          */}
          {deal.unreviewed && (
            <>
              {" · "}
              <span className="badge badge-attention" data-testid={`deal-unreviewed-${deal.id}`} title={`Filed from ${deal.source_channel}. Nobody has looked at it yet.`}>
                by email · not yet looked at
              </span>
            </>
          )}
        </div>
      </div>

      <div className="deal-stage">
        <span className={deal.status === "CLOSED" ? "stage-chip stage-chip-closed" : LIVE_STAGES.includes(deal.status) ? "stage-chip stage-chip-live" : "stage-chip"}>
          {s?.label ?? "Off the rail"}
        </span>
        {clock && (
          <div className={stalled ? "deal-sub deal-sub-stalled" : "deal-sub"} data-testid={`deal-age-${deal.id}`}>
            {clock.text}
          </div>
        )}
      </div>

      <div className={stalled || deal.placeholder_fields.length > 0 ? "deal-blocker warn" : "deal-blocker"}>
        {/* WHY IT LEFT, WHERE THE BLOCKER WOULD BE. A deal out of the pipeline has no blocker, and
            this column was showing it where we met them — true, and not the question anybody asks
            about a company the firm declined. The reason was recorded, required, and then never
            shown anywhere, which made every pass in the pile read as a bare "no". */}
        {left ? (
          <>
            <span className="eyebrow">{deal.status === "WITHDRAWN" ? "Why it went away" : "Why we said no"}</span>
            <br />
            <span data-testid={`deal-exit-reason-${deal.id}`}>
              {deal.exit_reason ?? "No reason was recorded — which is the part that would have been worth keeping."}
            </span>
          </>
        ) : deal.placeholder_fields.length > 0 ? (
          <>
            <span className="eyebrow">Needs from you</span>
            <br />
            {/*
              THE WARNING IS THE WAY IN. Operator: "i never realised it was the way to enter real
              numbers for sensori — this is a ui problem." It said a deal was carrying stand-in
              figures and offered no route to the one place they can be replaced. Now it opens the
              record, where those fields are on the second face.
            */}
            <button
              type="button"
              className="link-button"
              data-testid={`deal-placeholders-${deal.id}`}
              onClick={() => onOpen(deal.company_id, deal.company_name)}
            >
              {deal.placeholder_fields.length} value{deal.placeholder_fields.length === 1 ? " is a" : "s are"} placeholder
              {deal.placeholder_fields.length === 1 ? "" : "s"} — put the real ones in
            </button>
          </>
        ) : stalled ? (
          <>
            <span className="eyebrow">Blocked</span>
            <br />
            Nothing has happened for {stallRead(deal.status, deal.in_stage_since)?.label}
          </>
        ) : (
          <>
            <span className="eyebrow">Where it came from</span>
            <br />
            {originLabel(deal.relationship_origin)}
          </>
        )}
      </div>

      <div className="deal-actions">
        {next && (
          <button
            type="button"
            className="btn-strong"
            disabled={busy || settling}
            aria-busy={busy || settling || undefined}
            data-testid={`deal-advance-${deal.id}`}
            onClick={() => void moveTo(next.key)}
          >
            {busy || settling ? "…" : `Move to ${next.label.toLowerCase()}`}
          </button>
        )}
        {PASSABLE.includes(deal.status) && (
          <button
            type="button"
            className="btn-ghost"
            disabled={busy || settling}
            aria-expanded={asking === "pass"}
            data-testid={`deal-pass-${deal.id}`}
            onClick={() => setAsking(asking === "pass" ? null : "pass")}
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
          aria-expanded={asking === "remove"}
          data-testid={`deal-archive-${deal.id}`}
          onClick={() => setAsking(asking === "remove" ? null : "remove")}
        >
          Remove this record
        </button>
        {/* A pass is reversible, and the button says what it costs: the deal comes back at screening
            rather than where it left, because the reason it was passed on has to be looked at again. */}
        {(deal.status === "PASS" || deal.status === "WITHDRAWN") && (
          <button
            type="button"
            className="btn-ghost"
            disabled={busy || settling}
            data-testid={`deal-reopen-${deal.id}`}
            title="Brings it back at screening — the earlier work is not carried forward"
            onClick={() => void moveTo("SCREENING")}
          >
            {busy ? "…" : "Look at it again"}
          </button>
        )}
      </div>

      {/*
        AN EMPLOYEE'S VIEW, IN FRONT OF THE PARTNER RATHER THAN INSTEAD OF THEM.
        Operator rule: "every arrival survives until i've seen it but it comes with a
        recommendation to scrap it... never scrap our inbound stuff without our input." Letting the
        analyst pass it outright would have been one line of code and would have moved the deal out
        of the funnel — and what leaves the funnel is what you have to remember to go and look for.
      */}
      {deal.recommendation && (
        <div className="deal-recommendation deal-message" data-testid={`deal-recommendation-${deal.id}`}>
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

      {asking === "pass" && (
        <div className="deal-message">
          <ReasonField
            id={`deal-pass-reason-${deal.id}`}
            label={`Why is the firm passing on ${deal.company_name}?`}
            help="A sentence. It is what you will want in front of you the day they come back raising."
            minLength={12}
            tooShort="Say why in a sentence — a pass with no reason is worth nothing when they come back."
            confirmLabel="Pass on it"
            confirmClass="btn-danger"
            busy={busy}
            onConfirm={(reason) => void moveTo("PASS", reason)}
            onCancel={() => setAsking(null)}
            testId={`deal-pass-reason-${deal.id}`}
          />
        </div>
      )}
      {asking === "remove" && (
        <div className="deal-message">
          <ReasonField
            id={`deal-archive-reason-${deal.id}`}
            label={`Why should the record for ${deal.company_name} not exist?`}
            help="A duplicate, a typo — this is not a pass. Nothing is destroyed; the record keeps who removed it and why."
            minLength={8}
            tooShort="Say why in a few words — the reason is the only part that still helps later."
            confirmLabel="Remove it"
            confirmClass="btn-danger"
            busy={busy}
            onConfirm={async (reason) => {
              setBusy(true);
              const failed = mutationError(
                await api(`/api/opportunities/${deal.id}/archive`, { method: "POST", body: { reason } }),
                200,
              );
              setBusy(false);
              setMessage(failed ?? "Off the board. Nothing was destroyed — the record keeps who removed it and why.");
              if (!failed) {
                setAsking(null);
                onChanged();
              }
            }}
            onCancel={() => setAsking(null)}
            testId={`deal-archive-reason-${deal.id}`}
          />
        </div>
      )}

      {message && <div className="notice small deal-message" role="status">{message}</div>}
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

/* ── The committee face ──────────────────────────────────────────────────────────────────────
      Section 4 of the old Meetings page, moved here whole (design §1.1 #1: two objects on one
      page). The packet, what it does not know and who owes each answer, who is seated, the
      decision, and the dissent — and behind "Open the packet", the packet's own faces. ────── */

function CommitteeFace({
  companyName,
  deal,
  loading,
  me,
  onChanged,
  onNavigate,
}: {
  companyName: string;
  deal: CommitteeDeal | null;
  loading: boolean;
  me: MeResponse;
  onChanged: () => void;
  onNavigate: (key: string) => void;
}): JSX.Element {
  const [message, setMessage] = useState<string | null>(null);
  const [answering, setAnswering] = useState<string | null>(null);
  const [answer, setAnswer] = useState("");
  const [deciding, setDeciding] = useState(false);
  const [rationale, setRationale] = useState("");
  const [dissenting, setDissenting] = useState(false);
  const [dissent, setDissent] = useState("");
  const [packetOpen, setPacketOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  /*
   * The framework's readiness, for the scorecard: which sections are answered, and whether the
   * bear case is open and locked against the reader because they are the champion. Read here so
   * the committee face can say "11 of 11 answered · the Closing Six 5 of 6" without the packet
   * being opened; the packet's own Diligence face reads the same route to edit it.
   */
  const diligence = useApi<DiligenceSummary>(deal?.packet_id ? `/api/ic/packets/${deal.packet_id}/diligence` : null, [deal?.packet_id]);

  async function resolveQuestion(id: string, state: "ANSWERED" | "WITHDRAWN") {
    setBusy(true);
    const res = await api<{ error?: string; detail?: string }>(`/api/ic/questions/${id}/resolve`, {
      method: "POST",
      body: state === "ANSWERED" ? { state, answer } : { state, withdrawn_reason: answer },
    });
    setBusy(false);
    if (res.status >= 400) {
      setMessage(res.data?.detail ?? res.data?.error ?? `Could not record that (HTTP ${res.status}).`);
      return;
    }
    setAnswering(null);
    setAnswer("");
    onChanged();
  }

  /**
   * Put the packet in front of the partners.
   *
   * This does not decide anything. It raises the human-reserved approval card that an APPROVE has
   * to be recorded against, which is why the decision buttons only appear once it exists.
   */
  async function submitPacket(packetId: string) {
    setBusy(true);
    const res = await api<{ error?: string; detail?: string }>(`/api/ic/packets/${packetId}/submit`, { method: "POST", body: {} });
    setBusy(false);
    setMessage(
      res.status === 200
        ? "It is in front of both partners now. Approving the capital is a separate signature in Approvals."
        : res.data?.detail ?? res.data?.error ?? `Could not put it forward (HTTP ${res.status}).`,
    );
    onChanged();
  }

  async function decide(decision: "APPROVE" | "REJECT" | "DEFER") {
    if (!deal?.packet_id) return;
    setBusy(true);
    const res = await api<{ error?: string; detail?: string }>(`/api/ic/packets/${deal.packet_id}/decide`, {
      method: "POST",
      body: { decision, rationale, receipt_id: deal.approval_card ? deal.approval_card.id : undefined },
    });
    setBusy(false);
    if (res.status !== 201) {
      setMessage(res.data?.detail ?? res.data?.error ?? `Not recorded (HTTP ${res.status}).`);
      return;
    }
    setMessage(
      decision === "APPROVE"
        ? "Recorded. The deal is marked decided."
        : decision === "REJECT"
          ? "Recorded as a pass, with your reason, and the deal is on the pass pile. Nothing is deleted."
          : "Recorded as not yet. The deal stays where it is.",
    );
    setDeciding(false);
    setRationale("");
    onChanged();
  }

  /**
   * A partner disagreeing, in her own words, against the decision she disagreed with.
   *
   * The rule this exists to keep is the one `ic.ts` already holds: dissent is append-only and is
   * never folded into the rationale. Without a control it was a rule about a table nobody could
   * write to — a committee record that could only ever record agreement.
   */
  async function recordDissent(decisionId: string) {
    setBusy(true);
    const res = await api<{ error?: string; detail?: string }>(`/api/ic/decisions/${decisionId}/dissent`, {
      method: "POST",
      body: { dissent_text: dissent.trim() },
    });
    setBusy(false);
    if (res.status !== 201) {
      setMessage(res.data?.detail ?? res.data?.error ?? `Not recorded (HTTP ${res.status}).`);
      return;
    }
    setMessage("Recorded, in your words, against that decision. It cannot be edited or removed by anybody.");
    setDissenting(false);
    setDissent("");
    onChanged();
  }

  if (deal === null) {
    return (
      <p className="state-empty" data-testid="deal-committee-none">
        {loading
          ? "Reading the committee's file…"
          : `${companyName} has not been to the committee on this deal. Move it to Ready to decide on the first face and a packet opens on its own, with a card for the facilitator to assemble it.`}
      </p>
    );
  }

  const d = deal;
  const openCount = d.questions.filter((q) => q.state === "OPEN").length;
  const answeredCount = d.questions.filter((q) => q.state === "ANSWERED").length;

  return (
    <div className="stack" data-testid={`ic-deal-${d.opportunity_id}`}>
      {d.facilitator_card && (
        <p className="muted small" data-testid={`ic-card-${d.opportunity_id}`}>
          {d.seats.find((s) => !s.decides)?.name ?? "The facilitator"} is holding a work card to assemble it — {cardStateInWords(d.facilitator_card.state)}.{" "}
          <button type="button" className="link-button" onClick={() => onNavigate("work")}>
            Open Work cards
          </button>
        </p>
      )}

      <div className="two-col">
        <div className="stack">
          {/* ── What the packet does not know ──────────────────────────────────────────── */}
          <section className="card">
            <div className="panel-head">
              <h4>What the packet does not know</h4>
              <span className="muted small">
                {d.questions.length === 0
                  ? "nothing named yet"
                  : `${openCount} open · ${answeredCount} answered · who owes each answer`}
              </span>
            </div>
            {d.questions.length === 0 ? (
              <p className="state-empty">
                No gaps have been named yet. A packet with nothing open is either finished or
                unassembled — the packet state below says which.
              </p>
            ) : (
              <ul className="card-list small" data-testid={`ic-questions-${d.opportunity_id}`}>
                {d.questions.map((q) => (
                  <li key={q.id} className="ic-question" data-testid={`ic-question-${q.id}`}>
                    <span className={q.state === "OPEN" ? "badge badge-gate" : q.state === "ANSWERED" ? "badge badge-ok" : "badge"}>
                      {q.state === "OPEN" ? "open" : q.state === "ANSWERED" ? "answered" : "not needed"}
                    </span>{" "}
                    <strong>{q.question}</strong>
                    <div className="muted small">{q.because}</div>
                    <div className="ic-owes">Owed by {owedInWords(q)}</div>
                    {q.answer && <div className="closeout-quote">{q.answer}</div>}
                    {q.withdrawn_reason && <div className="muted small">Not needed because {q.withdrawn_reason}</div>}
                    {q.state === "OPEN" && answering !== q.id && (
                      <button type="button" className="link-button" data-testid={`ic-answer-${q.id}`} onClick={() => { setAnswering(q.id); setAnswer(""); }}>
                        Answer it
                      </button>
                    )}
                    {answering === q.id && (
                      <div className="stack">
                        <label className="field" htmlFor={`ic-answer-text-${q.id}`}>
                          The answer, or why it is not needed
                          <input id={`ic-answer-text-${q.id}`} value={answer} onChange={(e) => setAnswer(e.target.value)} data-testid={`ic-answer-text-${q.id}`} autoFocus />
                          <span className="field-help">What we found, in the words it was found in.</span>
                        </label>
                        <div className="row">
                          <button type="button" className="btn-strong" disabled={busy || !answer.trim()} data-testid={`ic-answer-save-${q.id}`} onClick={() => void resolveQuestion(q.id, "ANSWERED")}>
                            Save
                          </button>
                          <button type="button" disabled={busy || !answer.trim()} data-testid={`ic-withdraw-${q.id}`} onClick={() => void resolveQuestion(q.id, "WITHDRAWN")}>
                            We do not need this
                          </button>
                          <button type="button" className="btn-ghost" onClick={() => { setAnswering(null); setAnswer(""); }}>
                            Never mind
                          </button>
                        </div>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* ── What the committee has seen, and the packet behind it ──────────────────── */}
          <section className="card">
            <div className="panel-head">
              <h4>The packet</h4>
              <span className="muted small" data-testid={`ic-packet-state-${d.opportunity_id}`}>{d.packet_state}</span>
            </div>
            <ul className="card-list small" data-testid="deal-committee-packet">
              {d.packet_evidence ? (
                <>
                  <li data-testid="deal-committee-evidence">
                    <strong>
                      {count(d.packet_evidence.claims_seen)} claim
                      {d.packet_evidence.claims_seen === 1 ? "" : "s"} were in front of them
                      {d.packet_evidence.claims_unsourced > 0
                        ? `, ${count(d.packet_evidence.claims_unsourced)} of them with nothing under them`
                        : ", all of them with a source attached"}
                      .
                    </strong>
                    <div className="muted">
                      Put together by {d.packet_evidence.drafted_by} on {day(d.packet_evidence.assembled_at)} ·{" "}
                      {d.packet_evidence.deal_math_attached ? "the arithmetic is attached" : "no arithmetic is attached"}
                    </div>
                  </li>
                  <li data-testid="deal-committee-contradictions">
                    <strong>
                      {d.packet_evidence.contradictions_now === 0
                        ? "The record does not contradict itself in any material place."
                        : `The record contradicts itself in ${count(d.packet_evidence.contradictions_now)} material place${d.packet_evidence.contradictions_now === 1 ? "" : "s"} right now.`}
                    </strong>
                    {/* THE TWO COUNTS TRAVEL SEPARATELY ON PURPOSE. A contradiction opened after the
                        packet was written is the one nobody in the room knows about. */}
                    <div className="muted">
                      {d.packet_evidence.contradictions_at_assembly === 1
                        ? "One was open when the packet was put together"
                        : `${count(d.packet_evidence.contradictions_at_assembly)} were open when the packet was put together`}
                      {d.packet_evidence.contradictions_now > d.packet_evidence.contradictions_at_assembly
                        ? " — the rest were raised since, so nobody in the room has seen them"
                        : ""}
                    </div>
                  </li>
                </>
              ) : (
                <li className="state-empty">
                  No packet has been assembled, so the committee has seen nothing yet. It is assembled
                  by the facilitator from what the firm already holds; nothing is written to fill a hole.
                </li>
              )}
            </ul>
            {d.packet_id && (
              <div className="row">
                <button
                  type="button"
                  className="link-button"
                  aria-expanded={packetOpen}
                  data-testid={`ic-open-packet-${d.opportunity_id}`}
                  onClick={() => setPacketOpen((o) => !o)}
                >
                  {packetOpen ? "Close the packet" : "Open the packet"}
                </button>
                <span className="muted small">diligence · memo · market · people · audit</span>
              </div>
            )}
            {packetOpen && d.packet_id && <DealPacket packetId={d.packet_id} me={me} />}
          </section>

          {/* ── Diligence framework: the scorecard, and the champion lock said in words ──── */}
          {d.packet_id && (() => {
            const fw = diligence.data;
            if (!fw) {
              return (
                <section className="card" data-testid="ic-framework">
                  <div className="panel-head">
                    <h4>Diligence framework</h4>
                  </div>
                  <p className="state-empty">
                    {diligence.loading ? "Reading the framework…" : `The framework could not be read${diligence.status ? ` (HTTP ${diligence.status})` : ""}. The packet exists; its sections are behind “Open the packet”.`}
                  </p>
                </section>
              );
            }
            const answered = new Set(fw.answers.filter((a) => a.state === "ANSWERED" || a.state === "NOT_APPLICABLE").map((a) => a.section_id));
            const sections = [
              ...fw.framework.core.map((c) => ({ id: c.id, title: c.title })),
              ...(fw.framework.sector ? [{ id: `sector_${fw.framework.sector.sector.toLowerCase()}`, title: `${fw.framework.sector.title} (sector module)` }] : []),
            ];
            const six = fw.framework.closing_six.map((q) => ({ id: `closing_${q.n}`, title: `${q.n}. ${q.question}`, restricted: Boolean(q.championMayNotAnswer) }));
            const sixDone = six.filter((q) => answered.has(q.id)).length;
            const coreDone = sections.filter((x) => answered.has(x.id)).length;
            const isChampion = Boolean(fw.packet.champion_user_id && fw.packet.champion_user_id === me.id);
            const bear = six.find((q) => q.restricted && !answered.has(q.id));
            return (
              <section className="card" data-testid="ic-framework">
                <div className="panel-head">
                  <h4>Diligence framework</h4>
                  <span className="muted small">
                    {coreDone} of {sections.length} answered · the Closing Six {sixDone} of {six.length}
                  </span>
                </div>
                {bear && (
                  <p className="notice notice-gate" data-testid="ic-framework-bear-case">
                    {bear.title} is open
                    {isChampion
                      ? ", and you cannot write it: you are the champion. Someone else has to argue against this investment."
                      : ". Whoever is carrying the deal may not write it; someone else has to argue against this investment."}
                  </p>
                )}
                <ul className="scorecard" data-testid="ic-framework-scorecard">
                  {[...sections, ...six].map((x) => (
                    <li key={x.id}>
                      <span className="check">
                        <i className={answered.has(x.id) ? "on" : undefined} aria-hidden="true" />
                        {x.title}
                      </span>
                      <span className={answered.has(x.id) ? "badge badge-ok" : "badge badge-gate"}>{answered.has(x.id) ? "answered" : "open"}</span>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })()}

          {/* ── Who disagreed ──────────────────────────────────────────────────────────── */}
          <section className="card">
            <div className="panel-head">
              <h4>Who disagreed</h4>
              <span className="muted small">append-only</span>
            </div>
            <ul className="card-list small" data-testid={`ic-dissents-${d.opportunity_id}`}>
              {d.dissents.map((ds) => (
                <li key={ds.id} data-testid={`ic-dissent-${ds.id}`}>
                  <strong>{ds.dissenter}</strong> <span className="muted small">· disagreed with “{ds.decision.toLowerCase()}” · {whenInWords(ds.created_at)}</span>
                  {/* Printed in their own words, never condensed. A committee that records "we
                      agreed" over somebody who did not is wrong about the one thing worth going
                      back for. */}
                  <div className="closeout-quote">{ds.dissent_text}</div>
                </li>
              ))}
              {d.dissents.length === 0 && (
                <li className="state-empty">
                  {d.decision
                    ? "Nobody has written down a disagreement. That is not the same as everybody agreeing — it is only the same as nobody having said so here."
                    : "There is no decision to disagree with yet. Once one is recorded, a partner can write down here that they disagreed, and it cannot be edited or removed."}
                </li>
              )}
            </ul>
            {d.decision && (dissenting ? (
              <div className="stack">
                <label className="field" htmlFor={`ic-dissent-text-${d.opportunity_id}`}>
                  What you disagreed with
                  <input
                    id={`ic-dissent-text-${d.opportunity_id}`}
                    value={dissent}
                    data-testid={`ic-dissent-text-${d.opportunity_id}`}
                    onChange={(e) => setDissent(e.target.value)}
                    autoFocus
                  />
                  <span className="field-help">In your words — “the churn figure came from the founder and nothing else”.</span>
                </label>
                <div className="row">
                  <button
                    type="button"
                    className="btn-strong"
                    disabled={busy || dissent.trim().length < 4}
                    data-testid={`ic-dissent-save-${d.opportunity_id}`}
                    onClick={() => void recordDissent(d.decision!.id)}
                  >
                    Record it
                  </button>
                  <button type="button" className="btn-ghost" data-testid={`ic-dissent-cancel-${d.opportunity_id}`} onClick={() => { setDissenting(false); setDissent(""); }}>
                    Never mind
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="btn-ghost"
                data-testid={`ic-dissent-open-${d.opportunity_id}`}
                onClick={() => { setDissenting(true); setDissent(""); }}
              >
                Record that you disagreed with this
              </button>
            ))}
          </section>
        </div>

        <div className="stack">
          {/* ── Who is in the room ─────────────────────────────────────────────────────── */}
          <section className="card">
            <div className="panel-head">
              <h4>Who is in the room</h4>
            </div>
            <div data-testid={`ic-seats-${d.opportunity_id}`}>
              {d.seats.map((s) => (
                <div key={s.name} className="ic-seat">
                  <span className="avatar" aria-hidden="true">
                    {s.name.split(/\s+/).map((w) => w.charAt(0)).join("").slice(0, 2).toUpperCase()}
                  </span>
                  <span className="grow">
                    <strong>{s.name}</strong> · {s.role}
                  </span>
                  {s.decides ? <span className="badge badge-gate">decides</span> : <span className="badge">facilitates</span>}
                </div>
              ))}
              {d.seats.length === 0 && (
                <p className="state-empty">
                  Nobody is seated. A committee with no named members is one nobody has agreed to sit on.
                </p>
              )}
            </div>
            <p className="muted small">
              The committee is the partners. Investing needs the approval signed off in Approvals first; passing and deferring do not.
            </p>
          </section>

          {/* ── Record what the committee decided ──────────────────────────────────────── */}
          <section className="card">
            <div className="panel-head">
              <h4>{d.decision ? "What the committee decided" : "Record what the committee decided"}</h4>
            </div>
            {d.decision ? (
              <p className="notice small" data-testid={`ic-decision-${d.opportunity_id}`}>
                <strong>
                  {d.decision.decision === "APPROVE" ? "The firm is investing." : d.decision.decision === "REJECT" ? "The firm passed." : "Not yet — deferred."}
                </strong>{" "}
                {d.decision.rationale ?? "No reason was written down."}
                <span className="muted small"> · {d.decision.decided_by} · {whenInWords(d.decision.created_at)}</span>
              </p>
            ) : (
              <>
                {!d.packet_id && (
                  <p className="state-empty">
                    Nothing to decide against yet: the packet has not been assembled. The decision is
                    made against the packet, by the partners, with an approval receipt behind it.
                  </p>
                )}
                {d.packet_id && !d.approval_card && (
                  <>
                    <p className="muted small">
                      No decision recorded. Putting the packet in front of the partners raises the
                      approval an investment needs — it decides nothing by itself.
                    </p>
                    <button type="button" className="btn-strong" disabled={busy} data-testid={`ic-submit-${d.opportunity_id}`} onClick={() => void submitPacket(d.packet_id!)}>
                      Put it in front of the partners
                    </button>
                  </>
                )}
                {d.packet_id && d.approval_card && !deciding && (
                  <div className="stack">
                    <span className="muted small">
                      In front of both partners. Investing needs the approval signed off in Approvals
                      first; passing and deferring do not.
                    </span>
                    <div className="row">
                      <button type="button" className="btn-strong" data-testid={`ic-decide-${d.opportunity_id}`} onClick={() => { setDeciding(true); setRationale(""); }}>
                        Record what the committee decided
                      </button>
                    </div>
                  </div>
                )}
                {deciding && (
                  <div className="stack">
                    <label className="field" htmlFor={`ic-rationale-${d.opportunity_id}`}>
                      Why
                      <input
                        id={`ic-rationale-${d.opportunity_id}`}
                        value={rationale}
                        data-testid={`ic-rationale-${d.opportunity_id}`}
                        onChange={(e) => setRationale(e.target.value)}
                        autoFocus
                      />
                      {/* A pass needs a sentence. "We passed in August" is a fact; the reason is
                          what you want in front of you when they come back raising. */}
                      <span className={rationale.trim().length > 0 && rationale.trim().length < 12 ? "field-help err" : "field-help"}>
                        A sentence — a pass with fewer than twelve characters of reason is refused.
                      </span>
                    </label>
                    <div className="row">
                      <button type="button" className="btn-primary" disabled={busy} data-testid={`ic-invest-${d.opportunity_id}`} onClick={() => void decide("APPROVE")}>
                        The firm is investing
                      </button>
                      <button type="button" className="btn-danger" disabled={busy || rationale.trim().length < 12} data-testid={`ic-pass-${d.opportunity_id}`} onClick={() => void decide("REJECT")}>
                        The firm passes
                      </button>
                      <button type="button" disabled={busy} data-testid={`ic-defer-${d.opportunity_id}`} onClick={() => void decide("DEFER")}>
                        Not yet
                      </button>
                      <button type="button" className="btn-ghost" onClick={() => { setDeciding(false); setRationale(""); }}>
                        Never mind
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
            <p className="muted small">
              Append-only. A decision cannot be edited after the fact; a change of mind is a new decision with its own reason.
            </p>
          </section>
        </div>
      </div>

      {message && <p className="notice small" role="status" data-testid={`ic-message-${d.opportunity_id}`}>{message}</p>}
    </div>
  );
}

type RecordFace = "standing" | "deal" | "known" | "committee" | "history";

/**
 * ONE DEAL RECORD FOR ONE COMPANY, opened by picking the company and nothing else.
 *
 * Five faces, in the order of the questions a partner asks: where does it stand; what are the
 * terms; what do we know and how, and what is still unanswered; what has the committee said; what
 * has happened to it. Adding a second deal — the rare act — nests on the terms face.
 */
function CompanyDealRecord({
  companyId,
  companyName,
  boardDeals,
  initialFace,
  initialDealId,
  focusNonce,
  me,
  onChanged,
  onClose,
  onNavigate,
}: {
  companyId: string;
  companyName: string;
  /** The pipeline's own rows for this company: they carry the stage clock, which the deal row does not. */
  boardDeals: Deal[];
  initialFace: RecordFace;
  initialDealId: string | null;
  /** Bumped by every door that opens the record, so a second door on an already-open record still lands on its face. */
  focusNonce: number;
  me: MeResponse;
  onChanged: () => void;
  onClose: () => void;
  onNavigate: (key: string) => void;
}) {
  const deals = useApi<{ opportunities: DealRecordRow[] }>(`/api/opportunities?company_id=${companyId}`, [companyId]);
  const [dealId, setDealId] = useState<string | null>(initialDealId);
  const [face, setFace] = useState<RecordFace>(initialFace);
  /*
   * A DOOR OPENS THE FACE IT NAMES, EVEN ON A RECORD THAT IS ALREADY OPEN. The record is keyed on
   * the company, so pressing "Record what the committee decided" on the band while this company's
   * record is open on another face does not remount it — and a `useState` initial value is read
   * once. Caught by p60 on 19 Sep: the record opened on the terms face after "Add a company", the
   * band's button then landed on that same face, and the committee controls were not on screen.
   */
  useEffect(() => {
    setFace(initialFace);
    if (initialDealId) setDealId(initialDealId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusNonce]);
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
  const [askingPass, setAskingPass] = useState(false);

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
  const since = board?.in_stage_since ?? d?.created_at ?? null;
  const stall = d ? stallRead(d.status, since) : null;
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
    committee.reload();
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

  /* The same "a move is not over when the request returns" defect as `DealRow` above, on the open
     record's own copy of the control. `reloadAll()` cannot be awaited either, so the record went on
     offering the move it had just made until the refetch landed. */
  const [movedFrom, setMovedFrom] = useState<string | null>(null);
  const settling = movedFrom !== null && d?.status === movedFrom;
  useEffect(() => {
    if (movedFrom !== null && d?.status !== movedFrom) setMovedFrom(null);
  }, [d?.status, movedFrom]);

  async function moveTo(to: string, reason?: string) {
    if (!d) return;
    setBusy(true);
    const from = d.status;
    const failed = mutationError(
      await api(`/api/opportunities/${d.id}/transition`, { method: "POST", body: reason === undefined ? { to } : { to, reason } }),
      200,
    );
    setBusy(false);
    setMessage(failed ?? `${companyName} is now at ${(stage(to)?.label ?? "its new stage").toLowerCase()}.`);
    if (!failed) {
      setMovedFrom(from);
      setAskingPass(false);
      reloadAll();
    }
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
        note: `${provisional.map((f) => PLACEHOLDER_WORDS[f] ?? f).join(", ")} — the fields are on the next face.`,
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

  /* What each face holds, said on its tab so nobody opens one to find it blank. */
  const faces: Face[] = [
    { key: "standing", label: "Where this stands", badge: d ? { text: (s?.label ?? "off the rail").toLowerCase(), tone: stall?.stalled ? "bad" : undefined } : { text: "no deal" } },
    {
      key: "deal",
      label: "The deal itself",
      badge: !d ? { text: "empty" } : provisional.length > 0 ? { text: `${provisional.length} stand-in${provisional.length === 1 ? "" : "s"}`, tone: "gate" } : { text: "recorded" },
    },
    {
      key: "known",
      label: "What we know",
      badge: claims.length === 0 ? { text: "empty" } : unchecked.length > 0 ? { text: `${unchecked.length} unchecked`, tone: "gate" } : { text: `${claims.length} on record`, tone: "ok" },
    },
    {
      key: "committee",
      label: "The committee",
      badge: committeeDeal
        ? committeeDeal.decision
          ? { text: "decided", tone: "ok" }
          : committeeDeal.approval_card
            ? { text: "in front of the partners", tone: "gate" }
            : { text: "packet open" }
        : { text: "not yet" },
    },
    { key: "history", label: "History", badge: { text: entries.length === 0 ? "empty" : String(entries.length) } },
  ];

  return (
    <div className="deal-record" data-testid="deal-record">
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
            ↑ Close this record
          </button>
        </div>

        {d && <CompactRail status={d.status} since={since} name={companyName} />}

        {/* A company with more than one deal is a real question, so it is asked. One is not, so it
            is not: the record opens on the live deal without anybody choosing it. */}
        {rows.length > 1 && (
          <div className="chips" role="group" aria-label={`Which deal for ${companyName}`}>
            {rows.map((r) => (
              <button
                key={r.id}
                type="button"
                className="chip"
                aria-pressed={r.id === dealId}
                data-testid={`deal-record-pick-${r.id}`}
                onClick={() => setDealId(r.id)}
              >
                {r.title} <span className="muted">{stage(r.status)?.label ?? ""}</span>
              </button>
            ))}
          </div>
        )}

        {!d && (
          <p className="state-empty" data-testid="deal-record-none">
            {deals.loading
              ? "Opening the record…"
              : `No deal has been recorded against ${companyName} yet. Every face below is empty for that reason, not because it failed to load — add a deal on “The deal itself” and it will fill in.`}
          </p>
        )}
      </section>

      <Faces label={`${companyName}'s deal record`} faces={faces} active={face} onPick={(k) => setFace(k as RecordFace)} idPrefix="deal" testId="deal-face" />

      {/* ── 1 · WHERE THIS STANDS ──────────────────────────────────────────────────────────── */}
      <FacePanel idPrefix="deal" face="standing" active={face}>
        <section className="card" data-testid="deal-record-standing">
          {d ? (
            <>
              <div className="fact-grid">
                <Fact
                  label="In this stage"
                  value={stall ? stall.label : "not recorded"}
                  note={
                    stall && s?.stallAfterDays
                      ? stall.stalled
                        ? `past the ${s.stallAfterDays} days this stage is given — stalled`
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
                <Fact label="The question at this stage" value={s?.question ?? "—"} note={s?.isExit ? "it has left the pipeline" : undefined} />
              </div>

              <div className="record-actions">
                {next && (
                  <button type="button" className="btn-strong" disabled={busy || settling} aria-busy={busy || settling || undefined} data-testid="deal-record-advance" onClick={() => void moveTo(next.key)}>
                    {busy || settling ? "…" : `Move to ${next.label.toLowerCase()}`}
                  </button>
                )}
                {PASSABLE.includes(d.status) && (
                  <button
                    type="button"
                    className="btn-ghost"
                    disabled={busy || settling}
                    aria-expanded={askingPass}
                    data-testid="deal-record-pass"
                    onClick={() => setAskingPass((a) => !a)}
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
              {askingPass && (
                <ReasonField
                  id="deal-record-pass-reason"
                  label={`Why is the firm passing on ${companyName}?`}
                  help="A sentence. It is what you will want in front of you the day they come back raising."
                  minLength={12}
                  tooShort="Say why in a sentence — a pass with no reason is worth nothing when they come back."
                  confirmLabel="Pass on it"
                  confirmClass="btn-danger"
                  busy={busy}
                  onConfirm={(reason) => void moveTo("PASS", reason)}
                  onCancel={() => setAskingPass(false)}
                  testId="deal-record-pass-reason"
                />
              )}
            </>
          ) : (
            <p className="state-empty">There is no deal, so there is no stage. Add one on “The deal itself”.</p>
          )}
        </section>
      </FacePanel>

      {/* ── 2 · THE DEAL ITSELF ────────────────────────────────────────────────────────────── */}
      {/*
        THE FIELDS ARE THE POINT AND THEY ARE ALL VISIBLE. Operator: "price per share and # of
        shares should be in the deal record". They were on no surface at all — the only route to
        either was the transaction ladder, which books a position and is a different act from
        recording what a round is priced at. Nothing on this face is behind a toggle except the
        rare act of adding a second deal.
      */}
      <FacePanel idPrefix="deal" face="deal" active={face}>
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
                  <span className="muted small">No share class is recorded yet — add one further down this face.</span>
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

          {/*
            THE ONE THING ON THIS RECORD THAT NESTS, and it nests because the operator said it could:
            "yes and the add a second deal to this company part can be neested i guess." A company with
            a follow-on beside a secondary is real and rare; the ordinary case is one deal, and a form
            for the rare case sitting open above the work is what made this page feel like a form rather
            than a record.
          */}
          <details className="card deal-record-new" data-testid="deal-second-details">
            <summary>{rows.length === 0 ? `Add a deal for ${companyName}` : `Another deal for ${companyName} — a follow-on, or a secondary`}</summary>
            <p className="muted small">
              Only for a company already on the board. A company new to the firm goes in
              through “Add a company” on the pipeline.
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
        </section>
      </FacePanel>

      {/* ── 3 · WHAT WE KNOW, AND HOW WE KNOW IT — and what is still open ─────────────────── */}
      {/*
        RETHOUGHT RATHER THAN MOVED. Operator: "what the firm knows about them / its deals — these
        sections need to be rethought and figure out how to make this easy to work through."

        What a partner is actually doing here is separating what somebody CHECKED from what somebody
        SAID. So the unchecked come first, because they are the work, and every line carries how
        many sources stand behind it. The count that leads is the only honest headline: a page of
        claims with no sources should say so before anybody reads one.
      */}
      <FacePanel idPrefix="deal" face="known" active={face}>
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

        <section className="card" data-testid="deal-open-questions">
          <h4>What is still open</h4>
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
                  Important · owed by whoever is working the deal · the fields are on “The deal itself”
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
      </FacePanel>

      {/* ── 4 · THE COMMITTEE ──────────────────────────────────────────────────────────────── */}
      {/*
        WHY THIS IS NOT READ OUT OF `d.ic_packets`. The detail response carries `{ id, status }` per
        packet and nothing else — not the questions, not the seats, not the decision, and above all
        not the dissent. A face built on that would have had to invent the rest on the client, and a
        committee record that disagrees with the committee's own read is worse than no record.
        `GET /api/ic/deals/:opportunityId` is the SAME read the committee band renders.

        DISSENT IS NOT SUMMARISED, ANYWHERE. It is printed whole, beside the decision it was
        recorded against, and a decision with none says so — because "nobody disagreed" and "nobody
        wrote down that they disagreed" are different facts and only one of them is in the database.
      */}
      <FacePanel idPrefix="deal" face="committee" active={face}>
        <div data-testid="deal-committee">
          <p className="muted small record-lede">
            What the committee has seen, what it asked for and who owes each answer, who sits in the
            room, what it decided and who disagreed. A deal arrives here by moving to Ready to decide —
            nothing else puts it in front of them.
          </p>
          <CommitteeFace
            companyName={companyName}
            deal={committeeDeal}
            loading={committee.loading}
            me={me}
            onChanged={reloadAll}
            onNavigate={onNavigate}
          />
        </div>
      </FacePanel>

      {/* ── 5 · HISTORY ────────────────────────────────────────────────────────────────────── */}
      <FacePanel idPrefix="deal" face="history" active={face}>
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
      </FacePanel>

      {message && (
        <p className="notice" data-testid="deal-record-message" role="status">
          {message}
        </p>
      )}
    </div>
  );
}

/** A proposal card on the Waiting-on-you band: one click to move the deal, a reason to leave it. */
function ProposalCard({ p, onDone, onOpen }: {
  p: Proposal;
  onDone: () => void;
  onOpen: (companyId: string, name: string) => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [declining, setDeclining] = useState(false);
  const from = stage(p.from_status)?.label ?? p.from_status.toLowerCase();
  const to = stage(p.to_status)?.label ?? p.to_status.toLowerCase();

  async function decide(decision: "ACCEPT" | "DECLINE", note?: string) {
    setBusy(true);
    setError(null);
    const res = await api<{ error?: string; detail?: string }>(`/api/meeting-stage-proposals/${p.id}/decide`, {
      method: "POST",
      body: note === undefined ? { decision } : { decision, note },
    });
    setBusy(false);
    if (res.status !== 200) {
      // The server's own sentence where it wrote one ("no longer in Screening"), the status otherwise.
      setError(res.data?.detail ?? res.data?.error ?? `Could not do that (HTTP ${res.status}).`);
      return;
    }
    onDone();
  }

  return (
    <div className="card watch-banner" data-testid={`proposal-${p.id}`} data-state={error ? "error" : undefined}>
      <div className="row between">
        <div className="grow">
          <p className="eyebrow">
            From the room · {p.meeting_title} · {whenInWords(p.meeting_at ?? p.created_at)}
          </p>
          <p>
            <strong>
              Move {p.company_name} from {from} to {to}
            </strong>{" "}
            — {p.rationale} <span className="muted">{p.proposed_by} proposed it; the meeting's After face holds the reasoning.</span>
          </p>
        </div>
        <div className="deal-actions">
          <button type="button" className="btn-primary" disabled={busy} aria-busy={busy || undefined} data-testid={`proposal-accept-${p.id}`} onClick={() => void decide("ACCEPT")}>
            {busy && !declining ? "Moving…" : "Move it"}
          </button>
          <button type="button" disabled={busy} aria-expanded={declining} data-testid={`proposal-decline-${p.id}`} onClick={() => setDeclining((v) => !v)}>
            Leave it where it is
          </button>
          <button type="button" className="link-button" onClick={() => onOpen(p.company_id, p.company_name)}>
            Open the deal
          </button>
        </div>
      </div>
      {declining && (
        <ReasonField
          id={`proposal-decline-reason-${p.id}`}
          label="Why is it staying where it is?"
          help="A few words, so the next reader knows this was considered rather than missed."
          minLength={3}
          tooShort="Say why in a few words, so the next reader knows this was considered."
          confirmLabel="Leave it"
          confirmClass="btn-strong"
          busy={busy}
          onConfirm={(note) => void decide("DECLINE", note)}
          onCancel={() => setDeclining(false)}
          testId={`proposal-decline-reason-${p.id}`}
        />
      )}
      {error && (
        <p className="notice small" role="alert" data-testid={`proposal-error-${p.id}`}>
          {error}
        </p>
      )}
    </div>
  );
}

export function DealflowPage({ me, onNavigate }: { me: MeResponse; onNavigate: (key: string) => void }) {
  const board = useApi<Board>("/api/dealflow/board");
  const companies = useApi<{ companies: Array<{ id: string; canonical_name: string }> }>("/api/companies");
  // The committee band's read — every deal at or past the committee. One query, the record's face
  // reads the same one for one deal.
  const committee = useApi<CommitteeSurface>("/api/ic/deals");
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
   * WHICH COMPANY'S RECORD IS OPEN, and on which face. The whole of the second half of this page
   * is this one value. Operator: "you need to fix it once we pick a company and all the stuff
   * comes out." One value, set from any door — a row, a proposal, the committee band — and the
   * record is what comes out.
   */
  const [openCompany, setOpenCompany] = useState<{ id: string; name: string; face: RecordFace; dealId: string | null; nonce: number } | null>(null);
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
   * WHERE A DEAL STANDS, as a filter. The chips are the five questions somebody arrives with; a
   * rail node narrows to one stage (`stage:KEY`). "Live" is the working default.
   */
  const [filter, setFilter] = useState<string>("LIVE");

  const deals = board.data?.deals ?? [];
  const proposals = board.data?.proposals ?? [];
  const counts = board.data?.counts ?? {};
  const committeeDeals = committee.data?.deals ?? [];
  const facilitator = committee.data?.facilitator ?? null;

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

  const matchesFilter = (dd: Deal, key: string): boolean => {
    if (key.startsWith("stage:")) return dd.status === key.slice("stage:".length);
    const f = DEAL_FILTERS.find((x) => x.key === key);
    if (!f) return true;
    // "Needs you" adds the only condition the stage registry cannot express: how long it has sat.
    if (key === "NEEDS_YOU") return f.matches(dd.status) && Boolean(stallRead(dd.status, dd.in_stage_since)?.stalled);
    return f.matches(dd.status);
  };

  const countFor = (key: string) => deals.filter((dd) => matchesFilter(dd, key)).length;
  const shown = sorted.filter((dd) => matchesFilter(dd, filter));
  const filterLabel = filter.startsWith("stage:")
    ? `at ${(stage(filter.slice("stage:".length))?.label ?? "that stage").toLowerCase()}`
    : (DEAL_FILTERS.find((f) => f.key === filter)?.label ?? "shown").toLowerCase();

  /* ── What is waiting on a person, in the order it should be dealt with ─────────────────── */
  const unreviewed = deals.filter((dd) => dd.unreviewed);
  const inFront = committeeDeals.filter((c) => c.packet_id && c.approval_card && !c.decision);
  const waiting = proposals.length + inFront.length + unreviewed.length;
  /**
   * THE ONE ORANGE NODE. The stage where the first thing waiting on a person sits: a proposal's
   * current stage, else the committee, else New for an emailed arrival nobody has looked at. No
   * act waiting means no orange on the rail — orange is never a status.
   */
  const actStage: string | null = proposals[0]
    ? proposals[0].from_status
    : inFront.length > 0
      ? "IC_READY"
      : unreviewed.length > 0
        ? "NEW"
        : null;

  const live = deals.filter((dd) => !stage(dd.status)?.isExit && dd.status !== "CLOSED").length;
  const invested = counts.CLOSED ?? 0;
  const passed = (counts.PASS ?? 0) + (counts.WITHDRAWN ?? 0);

  /* The masthead: the answer, then the detail that explains it, derived from the counts loaded. */
  const answer = board.loading && !board.data
    ? "Reading the pipeline…"
    : deals.length === 0 && waiting === 0
      ? "Nothing is in the pipeline yet."
      : waiting === 0
        ? "Nothing is waiting on you."
        : waiting === 1
          ? "One decision is waiting on you."
          : `${waiting} decisions are waiting on you.`;
  const detail = (() => {
    const parts: string[] = [];
    const p0 = proposals[0];
    if (p0) {
      parts.push(
        proposals.length === 1
          ? `${p0.meeting_title} proposed moving ${p0.company_name} to ${(stage(p0.to_status)?.label ?? p0.to_status).toLowerCase()}.`
          : `${proposals.length} meetings proposed stage moves, the first for ${p0.company_name}.`,
      );
    }
    if (inFront.length > 0) {
      parts.push(inFront.length === 1 ? `${inFront[0]!.company_name ?? inFront[0]!.title} is in front of the partners.` : `${inFront.length} deals are in front of the partners.`);
    }
    if (unreviewed.length > 0) {
      parts.push(
        unreviewed.length === 1
          ? `${unreviewed[0]!.company_name} arrived by email and nobody has looked at it yet.`
          : `${unreviewed.length} companies arrived by email and nobody has looked at them yet.`,
      );
    }
    if (parts.length === 0) {
      const stalledCount = deals.filter((dd) => stallRead(dd.status, dd.in_stage_since)?.stalled).length;
      if (deals.length === 0) parts.push("Add a company below, or capture one as you meet them — every company the firm records enters at New.");
      else if (stalledCount > 0) parts.push(`${stalledCount} deal${stalledCount === 1 ? " has" : "s have"} sat past the stage's clock — the rows say which.`);
      else parts.push("Every live deal is inside its stage's clock.");
    }
    return parts.join(" ");
  })();

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
  function openRecord(id: string, name: string, face: RecordFace = "standing", dealId: string | null = null) {
    setOpenCompany((current) => ({ id, name, face, dealId, nonce: (current?.nonce ?? 0) + 1 }));
  }

  function reloadBoard() {
    board.reload();
    committee.reload();
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
    reloadBoard();
    // The record for what was just added opens straight away — that is the thing you came to fill in.
    if (id) openRecord(id, name, "deal", created.data.id);
  }

  if (board.loading && !board.data) return <p data-testid="dealflow-loading">Loading the pipeline…</p>;

  const today = new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });

  return (
    <section data-testid="dealflow-page">
      {/* ── The masthead: the answer a partner came for, derived from the counts the page loads. ── */}
      <header className="masthead">
        <p className="masthead-date" data-testid="dealflow-eyebrow">
          {today} · {live} live · {invested} invested · {passed} passed
        </p>
        <h2 data-testid="dealflow-answer">{answer}</h2>
        <p className="masthead-second" data-testid="dealflow-detail">{detail}</p>
      </header>

      {/* ── The rail IS the page. ── */}
      <StageRail counts={counts} actStage={actStage} filter={filter} onFilter={setFilter} />

      {/* ── Waiting on you: the human act, above everything else, with the page's one primary. ── */}
      <section className="band" data-testid="dealflow-waiting">
        <div className="band-head">
          <h3>Waiting on you</h3>
          {waiting > 0 && <span className="count-pill" data-testid="dealflow-waiting-count">{waiting}</span>}
          <span className="band-when">a proposal is never acted on without your click</span>
        </div>
        {waiting === 0 ? (
          <p className="state-empty" data-testid="dealflow-waiting-empty">
            Nothing is waiting on you. A stage move proposed in a meeting, a packet in front of the
            partners, or a company that arrived by email and has not been looked at would appear here.
          </p>
        ) : (
          <div className="stack">
            {proposals.map((p) => (
              <ProposalCard key={p.id} p={p} onDone={reloadBoard} onOpen={openRecord} />
            ))}
            {inFront.map((c) => (
              <div className="card" key={c.opportunity_id} data-testid={`waiting-committee-${c.opportunity_id}`}>
                <div className="row between">
                  <div className="grow">
                    <p className="eyebrow">At the committee</p>
                    <p>
                      <strong>{c.company_name ?? c.title} is in front of the partners.</strong>{" "}
                      <span className="muted">
                        {c.open_question_count === 0 ? "Nothing the packet does not know is still open." : `${c.open_question_count} thing${c.open_question_count === 1 ? "" : "s"} the packet does not know ${c.open_question_count === 1 ? "is" : "are"} still open.`}
                      </span>
                    </p>
                  </div>
                  <div className="deal-actions">
                    <button
                      type="button"
                      className="btn-strong"
                      disabled={!c.company_id}
                      title={c.company_id ? undefined : "Its company record is off the board, so the record cannot be opened from here"}
                      data-testid={`waiting-decide-${c.opportunity_id}`}
                      onClick={() => c.company_id && openRecord(c.company_id, c.company_name ?? c.title, "committee", c.opportunity_id)}
                    >
                      Record what the committee decided
                    </button>
                  </div>
                </div>
              </div>
            ))}
            {unreviewed.map((dd) => (
              <div className="card" key={dd.id} data-testid={`waiting-unreviewed-${dd.id}`}>
                <div className="row between">
                  <div className="grow">
                    <p className="eyebrow">Arrived by email</p>
                    <p>
                      <strong>{dd.company_name}</strong>{" "}
                      <span className="muted">arrived by email and nobody has looked at it. It stays until you do.</span>
                    </p>
                  </div>
                  <div className="deal-actions">
                    <button type="button" className="btn-strong" data-testid={`waiting-look-${dd.id}`} onClick={() => openRecord(dd.company_id, dd.company_name)}>
                      Look at it
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── The pipeline, with a way to narrow it and the one door in. ── */}
      <section className="band" data-testid="dealflow-pipeline">
        <div className="band-head">
          <h3>The pipeline</h3>
          <span className="band-when">sorted by what needs you soonest · press a company to open its record</span>
        </div>
        <div className="row between">
          <div className="chips" role="group" aria-label="Show">
            {DEAL_FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                className="chip"
                aria-pressed={filter === f.key}
                data-testid={`dealflow-filter-${f.key}`}
                onClick={() => setFilter(f.key)}
              >
                {f.label} · {countFor(f.key)}
              </button>
            ))}
          </div>
          <button type="button" className="btn-strong" aria-expanded={adding} data-testid="dealflow-add-toggle" onClick={() => setAdding((a) => !a)}>
            {adding ? "Cancel" : "Add a company"}
          </button>
        </div>
        {/*
          THE OTHER DOORS, stated once. Companies also arrive by email, from Network OS and from the
          analyst's own scouting — and since Phase A (migration 0197) every one of them files at New
          rather than opening a work card first. The old sentence here said the opposite.
        */}
        <p className="muted small" data-testid="dealflow-other-routes">
          Companies also arrive by email to {INTAKE_MAILBOX} tagged {EMAIL_TRIGGERS.map((t) => t.tag).join(" or ")},
          pushed across from Network OS, and from {DEAL_INTAKE_EMPLOYEE}'s own scouting. Every one enters at New,
          however it arrived, and stays until a person has looked at it.{" "}
          <button type="button" className="link-button" data-testid="dealflow-thesis" onClick={() => onNavigate("thesis")}>
            What we are looking for →
          </button>
        </p>

        {message && <p className="notice" role="status" data-testid="dealflow-message">{message}</p>}

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
              HOW LONG WE HAVE KNOWN THEM, asked at the moment the deal is created. `DealProvenance`
              measures lead time from exactly this field, so every deal opened through the ordinary
              door was contributing nothing to the band underneath it. Asked here, beside how we met
              them, because they are one thought: who introduced us, and how long ago.
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
              onChanged={reloadBoard}
              onOpen={openRecord}
            />
          ))}
          {shown.length === 0 && (
            <li className="state-empty" data-testid="dealflow-empty">
              {deals.length === 0
                ? "Nothing in the pipeline yet. Add a company above, or capture one as you meet them."
                : `Nothing is ${filterLabel}. The pipeline has ${deals.length} deal${deals.length === 1 ? "" : "s"} in other states.`}
            </li>
          )}
        </ul>
        <p className="muted small" data-testid="dealflow-staleness-note">{board.data?.how_staleness_works}</p>

        {openCompany && (
          <CompanyDealRecord
            key={openCompany.id}
            companyId={openCompany.id}
            companyName={openCompany.name}
            boardDeals={deals.filter((dd) => dd.company_id === openCompany.id)}
            initialFace={openCompany.face}
            initialDealId={openCompany.dealId}
            focusNonce={openCompany.nonce}
            me={me}
            onChanged={reloadBoard}
            onClose={() => setOpenCompany(null)}
            onNavigate={onNavigate}
          />
        )}
      </section>

      {/* ── The committee: moved here from Meetings (design §1.1 #1), where the stage lives. ── */}
      <section className="band" data-testid="dealflow-committee">
        <div className="band-head">
          <h3>The committee</h3>
          <span className="band-when">the packet, what it does not know, and who owes each answer</span>
        </div>
        {/*
          THE FOUR QUESTIONS, ANSWERED WHERE THEY ARE ASKED. Operator, 22 Aug 2026: "the IC flow ----
          who makes the packet how does that get done? how do we get thru the pipeline and what
          happens to the page once a deal is at the IC stage?" It renders whether or not any deal has
          got here — because the commonest moment somebody needs the answer is when the list below is
          empty and they cannot tell why.
        */}
        <p className="muted small" data-testid="ic-how-it-works">
          <strong>{facilitator?.name ?? "The committee's facilitator"} assembles the packet and never decides anything.</strong>{" "}
          A deal gets here by one move, made by a person, on the rail above — moving it to Ready to
          decide opens the packet and hands the facilitator a card to assemble it. Every gap becomes a
          question with a name on it; nothing is written to fill a hole. The partners decide, on the
          record's committee face, and the decision goes back to the pipeline: investing marks the
          deal decided, passing sends it to the pass pile with the reason, not yet leaves it where it is.
        </p>
        {facilitator && facilitator.status !== "ACTIVE" && (
          <p className="notice notice-gate small" data-testid="ic-facilitator-off">
            {facilitator.name} facilitates the committee — assembling the packet and recording the
            dissent — and is currently {facilitator.status.toLowerCase()}. The committee can still
            meet; nobody will prepare it or write it down.{" "}
            <button type="button" className="link-button" onClick={() => onNavigate("employees")}>
              Switch her on
            </button>
          </p>
        )}
        <ul className="deal-list" data-testid="ic-deals">
          {committeeDeals.map((c) => {
            const open = openCompany?.id === c.company_id && openCompany?.face === "committee";
            return (
              <li key={c.opportunity_id} className={open ? "deal-row deal-row-2 deal-row-selected" : "deal-row deal-row-2"} data-testid={`ic-row-${c.opportunity_id}`}>
                <div className="deal-company">
                  <div className="deal-name">{c.company_name ?? c.title}</div>
                  <div className="deal-sub">
                    {c.stage} · {c.packet_state}
                    {c.decision
                      ? ` · ${c.decision.decision === "APPROVE" ? "investing" : c.decision.decision === "REJECT" ? "passed" : "not yet"}`
                      : c.approval_card
                        ? " · in front of the partners"
                        : c.open_question_count > 0
                          ? ` · ${c.open_question_count} open`
                          : ""}
                  </div>
                </div>
                <div className="deal-actions">
                  <button
                    type="button"
                    className={c.approval_card && !c.decision ? "btn-strong" : "link-button"}
                    disabled={!c.company_id}
                    aria-expanded={open}
                    title={c.company_id ? undefined : "Its company record is off the board, so the record cannot be opened from here"}
                    data-testid={`ic-open-${c.opportunity_id}`}
                    onClick={() => c.company_id && openRecord(c.company_id, c.company_name ?? c.title, "committee", c.opportunity_id)}
                  >
                    {c.decision ? "Read what was decided" : c.approval_card ? "Record what the committee decided" : "Open the committee face"}
                  </button>
                </div>
              </li>
            );
          })}
          {committeeDeals.length === 0 && (
            <li className="state-empty" data-testid="no-ic-deals">
              {committee.loading && !committee.data
                ? "Reading the committee's file…"
                : "No deal is in front of the partners. A packet opens by itself when a deal reaches Ready to decide; the facilitator assembles it and never decides anything."}
            </li>
          )}
        </ul>
      </section>

      {/* WHERE DEALS COME FROM, the last band. */}
      <DealProvenance />
    </section>
  );
}
