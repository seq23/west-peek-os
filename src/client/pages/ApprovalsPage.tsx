import { useMemo, useState } from "react";
import { api, mutationError, useApi, type MeResponse } from "../lib/api";
import { actionDescription, actionName, actorName, approvalStateWords, roleWords } from "@shared/help/actionNames";
import { readableDate, shortDate } from "../lib/dates";
import { ApprovalContextPanel } from "./ApprovalContextPanel";

/**
 * Approvals — everything waiting on a person, and every way of answering it.
 *
 * THREE THINGS WERE MISSING, and the operator named all three (item 3, 21 Aug 2026): a card
 * treatment instead of a flat list, a BLOCK that is not a rejection, and being able to change a
 * decision after it has been made. Approve, send back and reject already existed; they rendered
 * only for a card waiting on a decision, and production had none, so the queue looked actionless.
 *
 * THE CARD TREATMENT is the one the work board already uses, deliberately. A card is a card: three
 * lines at rest — what state it is in, what it is, and who asked with what happens next — opening
 * to the whole thing. Inventing a second card here would have meant two components that drift.
 *
 * WHAT COLLAPSING MAY NOT HIDE. Anything still waiting on a decision opens by itself — including
 * the ones this reader may NOT decide, which is the case that looks like a mistake and is not. The
 * queue's job is to put live decisions in front of a person; folding one behind a chevron is how it
 * waits another day, and folding away the reason a control is disabled leaves a reader who lacks
 * the authority staring at a card that says nothing (the case `e2e/d1-design-states.spec.ts` exists
 * to catch). Everything already settled — decided, blocked, executed — starts closed, which is what
 * makes the queue readable again once it has a hundred rows in it.
 *
 * WHY THE CONTEXT PANEL ONLY LOADS WHEN THE CARD IS OPEN. It fetches per card. Rendering it for
 * every row meant one request per card on every page load, for cards nobody had looked at.
 */

interface DecisionRow {
  id: string;
  decision: string;
  decided_by: string;
  note: string | null;
  created_at: string;
  supersedes_decision_id?: string | null;
}

interface BlockRow {
  id: string;
  waiting_on: string;
  state_before: string;
  blocked_by: string;
  created_at: string;
  released_by: string | null;
  released_at: string | null;
  release_note: string | null;
}

export interface ApprovalCardRow {
  id: string;
  action_key: string;
  object_type: string;
  object_id: string;
  title: string;
  summary: string | null;
  state: string;
  requested_by_type: string;
  requested_by_id: string;
  required_approver_roles_json: string;
  risk_level?: string | null;
  expires_at?: string | null;
  decided_by: string | null;
  decision_note: string | null;
  created_at: string;
  /** Carried on the LIST row so a blocked card can say what it is waiting for without opening. */
  blocked_waiting_on?: string | null;
  decisions?: DecisionRow[];
  blocks?: BlockRow[];
}

/** Approval state is the product's core fact: it gets a tone, not just a word. */
function approvalStateBadge(state: string): string {
  if (state === "approved" || state === "executed") return "badge badge-ok";
  if (state === "rejected" || state === "blocked") return "badge badge-bad";
  if (state === "pending_review" || state === "revise_requested") return "badge badge-gate";
  return "badge";
}

/**
 * What a row in the trail SAYS, in the words a partner would use.
 *
 * The trail used to print `<code>revise_requested</code> by fu_sequoia_taylor`, on the one screen
 * somebody will open in three years to find out what the firm decided and why.
 */
const TRAIL_WORDS: Readonly<Record<string, string>> = {
  approved: "Approved",
  rejected: "Rejected",
  revise_requested: "Sent back for changes",
  reopened: "Took this decision back",
  blocked: "Blocked, waiting on something else",
  unblocked: "Block released",
};

function trailWords(decision: string): string {
  return TRAIL_WORDS[decision] ?? decision.replace(/_/g, " ");
}

/** The roles on a card, defensively — a malformed column must not blank the card. */
function rolesOn(card: ApprovalCardRow): string[] {
  try {
    return JSON.parse(card.required_approver_roles_json) as string[];
  } catch {
    return [];
  }
}

function releasableBy(card: ApprovalCardRow): string {
  const roles = rolesOn(card);
  return roles.length === 0 ? "somebody with the authority to decide this" : roles.map(roleWords).join(" or ");
}

/**
 * A block is not a rejection, and the queue has to say which one it is looking at.
 *
 * Reject means no, not this — a verdict on the request, and the end of it. Block means nothing here
 * proceeds until something ELSE is resolved: the request may be perfectly good, the ground under it
 * is not ready. So a block always names what it is waiting for, and it can always be released.
 */
function BlockPanel({
  card,
  block,
  canDecide,
  onChanged,
}: {
  card: ApprovalCardRow;
  block: BlockRow;
  canDecide: boolean;
  onChanged: () => void;
}): JSX.Element {
  const [resolution, setResolution] = useState("");
  const [failure, setFailure] = useState<string | null>(null);

  const release = async () => {
    setFailure(null);
    const failed = mutationError(
      await api(`/api/approvals/${card.id}/release`, { method: "POST", body: { reason: resolution } }),
      [200],
    );
    if (failed) {
      setFailure(failed); // The typed resolution is kept: it was written and the release did not happen.
      return;
    }
    setResolution("");
    onChanged();
  };

  return (
    <div className="approval-block" data-testid={`approval-block-${card.id}`}>
      <p>
        <strong>Waiting on: {block.waiting_on}</strong>
      </p>
      <p className="muted small">
        Put on hold by {actorName(block.blocked_by)} on {readableDate(block.created_at)}. Nothing here proceeds until
        that is resolved. Releasing it puts this back to{" "}
        {approvalStateWords(block.state_before).label.toLowerCase()} — it does not decide anything.
      </p>
      {failure && (
        <p className="notice notice-gate small" role="alert" data-testid={`release-failed-${card.id}`}>
          {failure}
        </p>
      )}
      {canDecide ? (
        <div className="form-row">
          <label>
            What resolved it?
            <input
              value={resolution}
              data-testid={`release-note-${card.id}`}
              placeholder="Counsel came back clean"
              onChange={(e) => setResolution(e.target.value)}
            />
          </label>
          <button type="button" className="btn-primary" data-testid={`release-${card.id}`} onClick={release}>
            Release the block
          </button>
        </div>
      ) : (
        <p className="notice small">Only {releasableBy(card)} can release this.</p>
      )}
    </div>
  );
}

/** Put a card on hold until a named thing is resolved. Deliberately its own control, not a verdict. */
function BlockForm({ card, onChanged }: { card: ApprovalCardRow; onChanged: () => void }): JSX.Element {
  const [waitingOn, setWaitingOn] = useState("");
  const [failure, setFailure] = useState<string | null>(null);

  const block = async () => {
    setFailure(null);
    const failed = mutationError(
      await api(`/api/approvals/${card.id}/block`, { method: "POST", body: { waiting_on: waitingOn } }),
      [201],
    );
    if (failed) {
      setFailure(failed);
      return;
    }
    setWaitingOn("");
    onChanged();
  };

  return (
    <div className="approval-secondary">
      <p className="lbl">Not a no — just not yet?</p>
      <p className="muted small">
        Block it instead. The request stays alive and comes back exactly as it is once whatever you name below is
        sorted out.
      </p>
      {failure && (
        <p className="notice notice-gate small" role="alert" data-testid={`block-failed-${card.id}`}>
          {failure}
        </p>
      )}
      <div className="form-row">
        <label>
          What has to happen first?
          <input
            value={waitingOn}
            data-testid={`block-waiting-on-${card.id}`}
            placeholder="Counsel has to clear the side letter"
            onChange={(e) => setWaitingOn(e.target.value)}
          />
        </label>
        <button type="button" data-testid={`block-${card.id}`} onClick={block}>
          Block until that is resolved
        </button>
      </div>
    </div>
  );
}

/**
 * Changing a decision after it has been made — the half of item 3 that shapes everything else.
 *
 * The decision trail refuses UPDATE and DELETE at the database layer, and that refusal is why the
 * trail is worth anything: nobody can go back and make Tuesday say something else. So this does not
 * edit the old decision. It records a NEW one that supersedes it, with who, when and why, and puts
 * the card back in front of a person to be decided again on whatever is now known. The original
 * decision stays on the card, marked as no longer standing, forever.
 */
function ReopenForm({ card, onChanged }: { card: ApprovalCardRow; onChanged: () => void }): JSX.Element {
  const [reason, setReason] = useState("");
  const [failure, setFailure] = useState<string | null>(null);

  const reopen = async () => {
    setFailure(null);
    const failed = mutationError(
      await api(`/api/approvals/${card.id}/reopen`, { method: "POST", body: { reason } }),
      [200],
    );
    if (failed) {
      setFailure(failed);
      return;
    }
    setReason("");
    onChanged();
  };

  return (
    <div className="approval-secondary">
      <p className="lbl">Changed your mind?</p>
      <p className="muted small">
        This does not erase what you decided before — nothing here can be erased. It records that you took the
        decision back, and puts this in front of you again to answer afresh.
      </p>
      {failure && (
        <p className="notice notice-gate small" role="alert" data-testid={`reopen-failed-${card.id}`}>
          {failure}
        </p>
      )}
      <div className="form-row">
        <label>
          Why are you changing this?
          <input
            value={reason}
            data-testid={`reopen-reason-${card.id}`}
            placeholder="The valuation the approval rested on turned out to be stale"
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        <button type="button" data-testid={`reopen-${card.id}`} onClick={reopen}>
          Change this decision
        </button>
      </div>
    </div>
  );
}

function ApprovalCard({
  card,
  me,
  startOpen,
  onDecided,
}: {
  card: ApprovalCardRow;
  me: MeResponse;
  startOpen: boolean;
  onDecided: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(startOpen);
  const [note, setNote] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  // Only fetched once the card is open — see the note at the top of the file.
  const detail = useApi<ApprovalCardRow>(open ? `/api/approvals/${card.id}` : null, [card.id, open, card.state]);
  const decisions = detail.data?.decisions ?? [];
  const blocks = detail.data?.blocks ?? [];
  const standingBlock = blocks.find((b) => b.released_at === null) ?? null;

  // A decision that has been taken back is still on the card, and has to LOOK taken back. Without
  // this the trail reads as two contradictory verdicts with no way to tell which one holds.
  const superseded = new Set(decisions.map((d) => d.supersedes_decision_id).filter(Boolean) as string[]);

  const requiredRoles = rolesOn(card);
  const holdsRole = requiredRoles.some((r) => me.roles.includes(r));
  const canDecide = card.state === "pending_review" && holdsRole;
  const canReopen = ["approved", "rejected", "revise_requested"].includes(card.state) && holdsRole;
  const canBlock = ["drafted", "pending_review", "revise_requested", "approved"].includes(card.state) && holdsRole;

  // "requested by HUMAN/fu_sequoia_taylor" is you. Saying so beats printing your own row id back.
  const whoRequested =
    card.requested_by_id === me.id ? "you" : card.requested_by_type === "HUMAN" ? "your partner" : card.requested_by_id;

  /*
   * THE RESULT IS READ, and that is not a refinement.
   *
   * This used to `await api(...)` and discard the status. The server answers 400, 403 and 409 as
   * JSON — a card that expired, a role the reader does not hold, a decision someone else already
   * made — and every one of them looked identical to success: the card reloaded unchanged and
   * nothing was said. On the page where the firm records its binding decisions, a refusal that
   * presents as a completed act is the worst failure this client can have.
   */
  const decide = async (decision: "approved" | "rejected" | "revise_requested") => {
    setFailure(null);
    const failed = mutationError(
      await api(`/api/approvals/${card.id}/decide`, { method: "POST", body: { decision, note: note || undefined } }),
      [200, 201],
    );
    if (failed) {
      setFailure(failed); // The note is kept: the operator wrote it and the decision did not happen.
      return;
    }
    setNote("");
    onDecided();
  };

  const words = approvalStateWords(card.state);
  const waitingOn = standingBlock?.waiting_on ?? card.blocked_waiting_on ?? null;

  return (
    <li className={open ? "card work-card-row is-open" : "card work-card-row"} data-testid={`approval-card-${card.id}`}>
      {/* The whole header is the toggle. A target you have to aim at is worse than the row you were
          already reading — the same conclusion the work board reached. */}
      <button
        type="button"
        className="work-card-summary"
        aria-expanded={open}
        data-testid={`approval-toggle-${card.id}`}
        onClick={() => setOpen(!open)}
      >
        <span className="work-card-meta">
          <span className={approvalStateBadge(card.state)} title={words.means}>
            {words.label}
          </span>
          {/* Risk rides on the collapsed row because it changes how hard you look before saying yes,
              and it is on the card record already — no second request to find it out. */}
          {(card.risk_level === "RESERVED" || card.risk_level === "HIGH") && (
            <span className="badge badge-gate" data-testid={`approval-risk-badge-${card.id}`}>
              {card.risk_level === "RESERVED" ? "reserved for a person" : "high risk"}
            </span>
          )}
          {canDecide && <span className="badge badge-gate">yours</span>}
          {card.expires_at && <span className="muted small">worth deciding by {shortDate(card.expires_at)}</span>}
          <span className={`work-card-chevron${open ? " is-open" : ""}`} aria-hidden="true">
            ›
          </span>
        </span>

        <strong className="work-card-title">{card.title}</strong>

        <span className="work-card-foot">
          <span className="muted small work-card-next">
            {waitingOn
              ? `Waiting on: ${waitingOn}`
              : `${actionName(card.action_key)} · asked for by ${card.requested_by_type === "AI" ? card.requested_by_id : whoRequested}`}
          </span>
        </span>
      </button>

      {open && (
        <div className="work-card-body">
          {/* WHAT YOU ARE ACTUALLY DECIDING, in English. This line used to read
              `action effect.email.send on external_effect/eff_01J… · requested by HUMAN/fu_sequoia_taylor`
              — six facts, all true, none of them readable, on the one page where a Managing Partner
              makes the firm's binding decisions. */}
          <p className="small">
            <strong>{actionName(card.action_key)}</strong>
            {actionDescription(card.action_key) ? ` — ${actionDescription(card.action_key)}` : ""}
          </p>
          {card.summary && <p className="small">{card.summary}</p>}
          <p className="muted small">
            Asked for by {card.requested_by_type === "AI" ? card.requested_by_id : whoRequested}
            {" · "}
            {requiredRoles.length === 0
              ? "no particular role is required"
              : `only ${requiredRoles.map(roleWords).join(" or ")} can decide this`}
          </p>

          {standingBlock && (
            <BlockPanel card={card} block={standingBlock} canDecide={holdsRole} onChanged={onDecided} />
          )}

          {/* Risk, evidence and questions. Canon §24.2 asks for these because an approval you have to
              leave the page to evaluate is one you end up rubber-stamping. */}
          <ApprovalContextPanel cardId={card.id} />

          {/* WHY THE BUTTONS ARE OFF. Three disabled buttons and no reason is the same failure as an
              empty page with no explanation: the operator cannot tell whether the system is broken,
              whether they lack permission, or whether the decision has already been made. */}
          {card.state !== "pending_review" && !standingBlock && (
            <p className="notice small" data-testid={`approval-why-locked-${card.id}`}>
              Nothing to decide — this is {words.label.toLowerCase()}. {words.means}
            </p>
          )}
          {/* A disabled control must say who it is waiting for. This used to be printed TWICE, once
              in English and once in role keys; it is now one message that carries both, because the
              English is what a partner reads and the keys are what you search for when the answer
              looks wrong. */}
          {card.state === "pending_review" && !canDecide && (
            <p className="notice notice-gate small" data-testid={`decision-blocked-${card.id}`}>
              This one is reserved for {requiredRoles.map(roleWords).join(" or ") || "a role you do not hold"}, and you
              are not one.{" "}
              <span className="muted small">
                needs {requiredRoles.join(" or ") || "—"} · you hold {me.roles.join(", ") || "no roles"}
              </span>
            </p>
          )}
          {failure && (
            <p className="notice notice-gate small" data-testid={`decision-failed-${card.id}`} role="alert">
              {failure}
            </p>
          )}

          {card.state === "pending_review" && (
            <div className="form-row">
              <label>
                Decision note
                <input
                  placeholder="optional — why you decided this way"
                  aria-label={`note-${card.id}`}
                  data-testid={`decision-note-${card.id}`}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </label>
              <button
                type="button"
                className="btn-primary"
                data-testid={`approve-${card.id}`}
                disabled={!canDecide}
                onClick={() => decide("approved")}
              >
                Approve
              </button>
              <button
                type="button"
                data-testid={`revise-${card.id}`}
                disabled={!canDecide}
                onClick={() => decide("revise_requested")}
              >
                Send back for changes
              </button>
              <button
                type="button"
                className="btn-danger"
                data-testid={`reject-${card.id}`}
                disabled={!canDecide}
                onClick={() => decide("rejected")}
              >
                Reject
              </button>
            </div>
          )}

          {canBlock && !standingBlock && <BlockForm card={card} onChanged={onDecided} />}
          {canReopen && <ReopenForm card={card} onChanged={onDecided} />}

          {decisions.length > 0 && (
            <>
              <p className="lbl">How this got here</p>
              <ul className="card-list small" data-testid={`decision-history-${card.id}`}>
                {decisions.map((d) => (
                  <li key={d.id} className={superseded.has(d.id) ? "approval-trail-superseded" : undefined}>
                    <strong>{trailWords(d.decision)}</strong> by {actorName(d.decided_by)},{" "}
                    {readableDate(d.created_at)}
                    {d.note ? ` — ${d.note}` : ""}
                    {superseded.has(d.id) && (
                      <span className="muted small" data-testid={`superseded-${d.id}`}>
                        {" "}
                        · taken back later, kept here because it happened
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}

          {/* The key stays, because when something goes wrong it is what you search for. */}
          <p className="muted small">
            <code>{card.action_key}</code> on{" "}
            <code>
              {card.object_type}/{card.object_id}
            </code>
          </p>
        </div>
      )}
    </li>
  );
}

const FILTERS = ["pending_review", "blocked", "drafted", "approved", "rejected", "revise_requested", "executed"];

/** The question each filter is actually answering, as a heading rather than a state name. */
const FILTER_HEADINGS: Readonly<Record<string, string>> = {
  pending_review: "What is waiting on a decision?",
  blocked: "What has stopped, and what is it waiting for?",
  drafted: "What has been written but not sent to anyone?",
  approved: "What has been said yes to but has not run yet?",
  rejected: "What was turned down?",
  revise_requested: "What went back for changes?",
  executed: "What actually happened?",
};

export function ApprovalsPage({ me, refreshNonce }: { me: MeResponse; refreshNonce: number }): JSX.Element {
  const [stateFilter, setStateFilter] = useState("pending_review");
  const approvals = useApi<{ approvals: ApprovalCardRow[] }>(`/api/approvals?state=${stateFilter}`, [refreshNonce]);
  const cards = useMemo(() => approvals.data?.approvals ?? [], [approvals.data]);

  // Which cards this reader can act on right now. They open by themselves; see the file note.
  const mine = useMemo(() => {
    return new Set(
      cards
        .filter((c) => {
          if (c.state !== "pending_review") return false;
          try {
            return (JSON.parse(c.required_approver_roles_json) as string[]).some((r) => me.roles.includes(r));
          } catch {
            return false;
          }
        })
        .map((c) => c.id),
    );
  }, [cards, me.roles]);

  return (
    <section data-testid="approvals-page">
      <div className="home-section-head">
        <h4>
          {FILTER_HEADINGS[stateFilter] ?? "What is in the queue?"} <span className="count-pill">{cards.length}</span>
        </h4>
        {mine.size > 0 && (
          <span className="muted small">
            {mine.size} of these {mine.size === 1 ? "is" : "are"} yours to answer, and {mine.size === 1 ? "is" : "are"}{" "}
            open below.
          </span>
        )}
      </div>

      <div className="form-row">
        <label>
          Show{" "}
          <select data-testid="approval-filter" value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}>
            {FILTERS.map((s) => (
              <option key={s} value={s}>
                {approvalStateWords(s).label}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="btn-ghost" onClick={() => approvals.reload()}>
          Refresh
        </button>
      </div>

      <ul className="approval-queue" data-testid="approval-list">
        {cards.map((c) => (
          <ApprovalCard
            key={`${c.id}:${c.state}`}
            card={c}
            me={me}
            startOpen={c.state === "pending_review"}
            onDecided={() => approvals.reload()}
          />
        ))}
      </ul>

      {!approvals.loading && cards.length === 0 && (
        <p className="state-message" data-testid="approvals-empty">
          {/* The dropdown above already turns `pending_review` into "Waiting on you"; this sentence
              printed the raw enum instead, so the page named the same state two ways in one screen
              and one of them was a database value. */}
          Nothing is {approvalStateWords(stateFilter).label.toLowerCase()}. Cards arrive here when a reserved action is
          requested — from a work card, a transaction, an LP claim, an allocation option, or a policy change. Nothing
          executes without one.
        </p>
      )}
    </section>
  );
}
