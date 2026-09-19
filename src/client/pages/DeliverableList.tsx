import { useEffect, useState } from "react";
import { api, useApi } from "../lib/api";
import { kindDef } from "@shared/deliverables/deliverable";
import { portraitAlt, portraitFor } from "../lib/employeePortraits";
import { HireCandidatePanel } from "./HireCandidatePanel";
import { DeliverableDocument } from "./DeliverableDocument";

/**
 * Things the firm has handed you.
 *
 * ONE COMPONENT FOR ALL FOUR KINDS, used on Research, on Home, and anywhere else a deliverable
 * should surface. The operator asked for download and email on research packets; building it once
 * means the morning brief and the weekly review get the same two buttons rather than each waiting
 * its turn for a copy of the same code.
 *
 * FILTERED BY KIND WHERE IT IS EMBEDDED, unfiltered on Home. Research shows the latest few research
 * packets; Home shows everything anybody prepared for you.
 */

interface Deliverable {
  id: string;
  kind: string;
  title: string;
  body: string;
  prepared_by: string;
  prepared_for: string;
  document_id: string | null;
  created_at: string;
  acknowledged_at: string | null;
  dismissed_at: string | null;
  prepared_for_name: string | null;
  /** Why it is on the put-away list: she put it there, or a week went by unread. */
  put_away?: "BY_YOU" | "AFTER_A_WEEK" | null;
}

/** The one-word reads a partner can leave without writing a sentence. */
const VERDICTS: { value: string; label: string }[] = [
  { value: "GOOD", label: "This was good" },
  { value: "NOT_WHAT_I_WANTED", label: "Not what I wanted" },
  { value: "TOO_LONG", label: "Too long" },
  { value: "WRONG_FOCUS", label: "Wrong focus" },
  { value: "NOTE", label: "Just a note" },
];

export function DeliverableList({
  kind,
  excludeKind,
  limit = 5,
  emptyNote,
  onNavigate,
  mine = false,
  meId,
  selectable = false,
  selected,
  onSelect,
  reloadKey = 0,
  onRows,
}: {
  kind?: string;
  /** A kind the list must NOT carry — Home's Arrived band excludes `daily_brief`, which the brief band above it is. */
  excludeKind?: string;
  limit?: number;
  emptyNote: string;
  onNavigate?: (k: string) => void;
  /** Only what was prepared for the reader. Home sets this; shared surfaces do not. */
  mine?: boolean;
  /** The reader, so a shared list can mark the rows that are somebody else's. */
  meId?: string;
  /** SELECT-MANY (design/HOME_DESIGN.md §3.4): a checkbox per row, owned by the host's select bar. */
  selectable?: boolean;
  selected?: ReadonlySet<string>;
  onSelect?: (id: string, on: boolean) => void;
  /** Bumped by the host after a batch act, so the list re-reads. */
  reloadKey?: number;
  /** The rows as read, so a host can count them and offer `Mark all read` over exactly these. */
  onRows?: (rows: Array<{ id: string; acknowledged_at: string | null }>) => void;
}): JSX.Element {
  // The default view is what still wants attention. Dismissed pieces are one toggle away, never
  // more than that, because "where did it go" is the question dismissing usually creates.
  const [showDismissed, setShowDismissed] = useState(false);
  const list = useApi<{ deliverables: Deliverable[]; put_away_after_days?: number }>(
    `/api/deliverables?limit=${limit}${kind ? `&kind=${kind}` : ""}${excludeKind ? `&exclude_kind=${excludeKind}` : ""}${showDismissed ? "&dismissed=1" : ""}${mine ? "&mine=1" : ""}`,
    [reloadKey, showDismissed],
  );
  useEffect(() => {
    if (list.data) onRows?.(list.data.deliverables.map((d) => ({ id: d.id, acknowledged_at: d.acknowledged_at })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.data]);
  const [open, setOpen] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [feedbackFor, setFeedbackFor] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [verdict, setVerdict] = useState("NOTE");

  async function act(id: string, path: string, label: string) {
    setBusy(id);
    const res = await api(`/api/deliverables/${id}/${path}`, { method: "POST", body: {} });
    setBusy(null);
    setMessage(res.status === 200 ? label : `That did not work (HTTP ${res.status}).`);
    list.reload();
  }

  async function sendFeedback(d: Deliverable) {
    setBusy(d.id);
    const res = await api<{ error?: string }>(`/api/deliverables/${d.id}/feedback`, {
      method: "POST",
      body: { note, verdict },
    });
    setBusy(null);
    if (res.status === 201) {
      setMessage(`Passed on to ${d.prepared_by}. It will be in front of them the next time they write one.`);
      setFeedbackFor(null);
      setNote("");
      setVerdict("NOTE");
    } else {
      setMessage(`Could not send that: ${res.data?.error ?? res.status}`);
    }
  }

  const rows = list.data?.deliverables ?? [];

  async function emailIt(id: string) {
    setBusy(id);
    setMessage(null);
    const res = await api<{ sent?: boolean; detail?: string; error?: string; to?: string }>(
      `/api/deliverables/${id}/email`,
      { method: "POST", body: {} },
    );
    setBusy(null);
    // "Sending is switched off" is a real answer and is reported as one rather than as success.
    setMessage(
      res.status === 200
        ? res.data?.sent
          ? `Sent to ${res.data.to}.`
          : res.data?.detail ?? "Nothing was sent."
        : `Could not send it: ${res.data?.detail ?? res.data?.error ?? res.status}`,
    );
  }

  // THE RULE, ON THE PAGE. A piece that vanishes after a week with no word about why reads as a
  // bug; the same piece under "Show what I put away" with the rule stated beside the toggle is a
  // tidy desk (operator, 15 Sep 2026).
  const dismissedToggle = (
    <p className="muted small" data-testid="deliverables-put-away-rule">
      <button
        type="button"
        className="link-button small"
        data-testid="deliverables-toggle-dismissed"
        onClick={() => setShowDismissed(!showDismissed)}
      >
        {showDismissed ? "← Back to current" : "Show what I put away"}
      </button>
      {" "}· anything not marked as read within {list.data?.put_away_after_days ?? 7} days is put away by itself; the latest morning brief replaces the one before.
    </p>
  );

  if (!list.loading && rows.length === 0) {
    return (
      <>
        <p className="state-empty" data-testid="deliverables-empty">
          {showDismissed ? "Nothing has been put away." : emptyNote}
        </p>
        {dismissedToggle}
      </>
    );
  }

  return (
    <>
      {message && <p className="notice small" data-testid="deliverables-message">{message}</p>}
      <ul className="deliverable-list" data-testid="deliverable-list">
        {rows.map((d) => {
          const def = kindDef(d.kind);
          const isOpen = open === d.id;
          return (
            <li
              key={d.id}
              className={d.acknowledged_at ? "card deliverable deliverable-read" : "card deliverable"}
              data-testid={`deliverable-${d.id}`}
            >
              <div className="deliverable-head">
                {selectable && (
                  <label className="check row-select">
                    <input
                      type="checkbox"
                      data-testid={`deliverable-select-${d.id}`}
                      aria-label={`Select ${d.title}`}
                      checked={selected?.has(d.id) ?? false}
                      onChange={(e) => onSelect?.(d.id, e.target.checked)}
                    />
                  </label>
                )}
                {/* SIGNED. Everything the firm produces arrives from somebody, with their face on
                    it — the whole point of the delivery model. */}
                <span className="owner-chip">
                  {portraitFor(d.prepared_by) ? (
                    <img className="owner-face" src={portraitFor(d.prepared_by)!} alt={portraitAlt(d.prepared_by, "prepared this")} loading="lazy" />
                  ) : (
                    <span className="owner-face owner-face-initial" aria-hidden="true">{d.prepared_by.slice(0, 1)}</span>
                  )}
                  {d.prepared_by}
                </span>
                <span className="badge">{def?.label ?? d.kind}</span>
                <span className="muted small">{new Date(d.created_at).toLocaleDateString()}</span>
                {/* Read is a state, and it is said in words as well as in colour. */}
                {d.acknowledged_at && !d.dismissed_at && (
                  <span className="badge badge-quiet" data-testid={`deliverable-read-${d.id}`}>read</span>
                )}
                {d.put_away === "AFTER_A_WEEK" ? (
                  <span className="badge badge-quiet" data-testid={`deliverable-aged-${d.id}`}>put away after a week, unread</span>
                ) : d.dismissed_at ? (
                  <span className="badge badge-quiet">put away</span>
                ) : null}
                {/* On a shared surface, whose piece this is. A morning brief is addressed and
                    signed by that partner's own chief of staff, so an unlabelled one sitting in
                    somebody else's list reads as their chief of staff having changed. */}
                {meId && d.prepared_for !== meId && d.prepared_for_name && (
                  <span className="badge badge-quiet" data-testid={`deliverable-for-${d.id}`}>
                    for {d.prepared_for_name.split(" ")[0]}
                  </span>
                )}
              </div>

              <button
                type="button"
                className="link-button deliverable-title"
                data-testid={`deliverable-open-${d.id}`}
                onClick={() => setOpen(isOpen ? null : d.id)}
              >
                {d.title}
              </button>
              {!isOpen && <p className="muted small">{def?.blurb}</p>}

              {isOpen && <DeliverableDocument body={d.body} testId={`deliverable-doc-${d.id}`} />}
              {/* Walker's hire search carries the candidates behind it, each with Contacted / Pass,
                  so Scooter answers the note where he reads it and next week's leaves them out. */}
              {isOpen && d.kind === "productions_hire_search" && <HireCandidatePanel deliverableId={d.id} />}

              <div className="form-row deliverable-actions">
                {/* A plain link, not a fetch: the browser handles the save dialog and the filename
                    comes from the content-disposition header the route already sets. */}
                <a className="link-button" href={`/api/deliverables/${d.id}/download`} data-testid={`deliverable-download-${d.id}`}>
                  Download
                </a>
                <button
                  type="button"
                  className="link-button"
                  disabled={busy === d.id}
                  data-testid={`deliverable-email-${d.id}`}
                  onClick={() => void emailIt(d.id)}
                >
                  {busy === d.id ? "Sending…" : "Email it to me"}
                </button>
                {onNavigate && d.document_id && (
                  <button type="button" className="link-button" onClick={() => onNavigate("documents")}>
                    Find it in Documents
                  </button>
                )}
                {!d.document_id && (
                  <span className="muted small" title="The handover stands; the archive copy did not save">
                    not filed
                  </span>
                )}
              </div>

              {/* ── Answering it ──
                  Acknowledge is one click and says so. Putting it away is reversible and the button
                  says where it goes, because "dismiss" on its own reads as delete. Feedback is the
                  one that changes next week's version, so it names who receives it. */}
              <div className="form-row deliverable-answer">
                {d.dismissed_at || d.put_away === "AFTER_A_WEEK" ? (
                  <button
                    type="button"
                    className="link-button"
                    disabled={busy === d.id}
                    data-testid={`deliverable-restore-${d.id}`}
                    onClick={() => void act(d.id, "dismiss?restore=1", "Back on the page.")}
                  >
                    Put it back
                  </button>
                ) : (
                  <>
                    {!d.acknowledged_at && (
                      <button
                        type="button"
                        className="btn-ghost"
                        disabled={busy === d.id}
                        data-testid={`deliverable-ack-${d.id}`}
                        onClick={() => void act(d.id, "acknowledge", "Marked as read.")}
                      >
                        Mark as read
                      </button>
                    )}
                    <button
                      type="button"
                      className="link-button"
                      disabled={busy === d.id}
                      data-testid={`deliverable-dismiss-${d.id}`}
                      onClick={() => void act(d.id, "dismiss", "Put away. It is under \u201cShow what I put away\u201d.")}
                    >
                      Put it away
                    </button>
                  </>
                )}
                <button
                  type="button"
                  className="link-button"
                  data-testid={`deliverable-feedback-${d.id}`}
                  onClick={() => setFeedbackFor(feedbackFor === d.id ? null : d.id)}
                >
                  {feedbackFor === d.id ? "Never mind" : `Tell ${d.prepared_by} what you think`}
                </button>
              </div>

              {feedbackFor === d.id && (
                <div className="deliverable-feedback" data-testid={`deliverable-feedback-form-${d.id}`}>
                  <label htmlFor={`fb-verdict-${d.id}`}>How was it?</label>
                  <select
                    id={`fb-verdict-${d.id}`}
                    value={verdict}
                    onChange={(e) => setVerdict(e.target.value)}
                  >
                    {VERDICTS.map((v) => (
                      <option key={v.value} value={v.value}>{v.label}</option>
                    ))}
                  </select>
                  <label htmlFor={`fb-note-${d.id}`}>What should they do differently?</label>
                  <textarea
                    id={`fb-note-${d.id}`}
                    rows={3}
                    value={note}
                    placeholder="Lead with the private-market read, not macro. And half this length."
                    onChange={(e) => setNote(e.target.value)}
                  />
                  <p className="muted small">
                    {d.prepared_by} is shown this before writing the next one.
                  </p>
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={busy === d.id || !note.trim()}
                    data-testid={`deliverable-feedback-send-${d.id}`}
                    onClick={() => void sendFeedback(d)}
                  >
                    Send it to {d.prepared_by}
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {dismissedToggle}
    </>
  );
}
