import { useState } from "react";
import { api, useApi } from "../lib/api";

/**
 * The BEFORE and AFTER faces of a meeting on its record (Phase B).
 *
 * Deliberately plain. Phase D redesigns the visuals; this renders what the server holds so that
 * nothing the model produced can be acted on without a person reading it first. The rule the
 * panel keeps: a draft is a proposal, the four objects are records, and the button between them
 * is the partner's.
 */

interface BriefLine {
  text: string;
  sourceType: string;
  sourceId: string;
}

interface BriefCommitmentLine extends BriefLine {
  owner_side: "FIRM" | "COUNTERPARTY";
  owed_by: string | null;
  due_date: string | null;
  standing: "OPEN" | "OVERDUE" | "DELIVERED" | "CONVERTED" | "DROPPED";
  meeting_title: string;
}

interface MeetingBrief {
  prepared_by: string;
  why: string | null;
  why_unavailable: string | null;
  find_out: BriefLine[];
  last_time: { firm: BriefCommitmentLine[]; counterparty: BriefCommitmentLine[] };
  record: { about: "COMPANY" | "LP" | "NOBODY"; name: string | null; summary: string | null; stage: string | null; touches: BriefLine[] };
  diligence: { answered: number; unanswered: number; packet_id: string | null } | null;
  coverage: Array<{ source: string; rowsRead: number }>;
  unreadable: string[];
  body: string;
}

interface BriefResponse {
  brief: { id: string; created_at: string; brief: MeetingBrief; body_md: string } | null;
  ready: boolean;
  note: string | null;
}

function standingInWords(s: BriefCommitmentLine["standing"]): string {
  switch (s) {
    case "OPEN": return "still open";
    case "OVERDUE": return "overdue";
    case "DELIVERED": return "delivered";
    case "CONVERTED": return "on a work card";
    case "DROPPED": return "dropped";
  }
}

/** BEFORE: the brief, or a named absence and the button that builds one. */
export function BeforePanel({ meetingId, onChanged }: { meetingId: string; onChanged: () => void }): JSX.Element {
  const state = useApi<BriefResponse>(`/api/meetings/${meetingId}/brief`, [meetingId]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const b = state.data?.brief?.brief ?? null;

  async function build() {
    setBusy(true);
    setMessage(null);
    const res = await api<{ error?: string; detail?: string }>(`/api/meetings/${meetingId}/prep`, { method: "POST", body: {} });
    setBusy(false);
    if (res.status !== 201) setMessage(`The brief could not be built: ${res.data?.detail ?? res.data?.error ?? res.status}`);
    else setMessage("Brief built. It says what it examined at the foot.");
    state.reload();
    onChanged();
  }

  return (
    <div data-testid={`before-${meetingId}`}>
      <h4>Before: the brief</h4>
      {state.data && !b && (
        <p className="state-empty" data-testid="brief-none">
          {state.data.note ?? "No brief yet."}
        </p>
      )}
      {b && (
        <div data-testid="brief">
          <p className="muted small">
            Prepared by {b.prepared_by} · {state.data?.brief?.created_at.slice(0, 16).replace("T", " ")}Z
          </p>
          <p data-testid="brief-why">
            <strong>Why this meeting exists.</strong>{" "}
            {b.why ?? <span className="help-tag help-tag-warn">No line could be written — {b.why_unavailable ?? "no reason given"}</span>}
          </p>
          <p className="small"><strong>What we need to find out</strong></p>
          <ul className="card-list small" data-testid="brief-find-out">
            {b.find_out.map((q) => <li key={q.sourceId + q.text}>{q.text}</li>)}
            {b.find_out.length === 0 && <li className="state-empty">No open questions are carried forward.</li>}
          </ul>
          <p className="small"><strong>What we said last time</strong></p>
          <ul className="card-list small" data-testid="brief-last-time">
            {b.last_time.firm.map((c) => (
              <li key={c.sourceId}>
                <span className="help-tag help-tag-muted">we said</span> {c.text}{" "}
                <span className={c.standing === "OVERDUE" ? "help-tag help-tag-warn" : "help-tag help-tag-good"}>{standingInWords(c.standing)}</span>
              </li>
            ))}
            {b.last_time.counterparty.map((c) => (
              <li key={c.sourceId}>
                <span className="help-tag help-tag-muted">they said</span> {c.text}{c.owed_by ? ` (${c.owed_by})` : ""}{" "}
                <span className={c.standing === "OVERDUE" ? "help-tag help-tag-warn" : "help-tag help-tag-good"}>{standingInWords(c.standing)}</span>
              </li>
            ))}
            {b.last_time.firm.length + b.last_time.counterparty.length === 0 && (
              <li className="state-empty">Nothing is on record from an earlier meeting with them.</li>
            )}
          </ul>
          <p className="small"><strong>The record</strong></p>
          <p className="muted small" data-testid="brief-record">
            {b.record.about === "NOBODY"
              ? "This meeting is about neither a company nor an LP."
              : `${b.record.name}${b.record.stage ? ` — ${b.record.stage}` : ""}`}
          </p>
          {b.diligence && (
            <p className="muted small" data-testid="brief-diligence">
              Diligence framework: {b.diligence.answered} answered · {b.diligence.unanswered} open
              {b.diligence.packet_id ? "" : " · no IC packet exists yet"}
            </p>
          )}
          <p className="muted small" data-testid="brief-coverage">
            Examined: {b.coverage.map((c) => `${c.source} (${c.rowsRead})`).join(" · ")}
            {b.unreadable.length > 0 && ` · could not read: ${b.unreadable.join(", ")}`}
          </p>
        </div>
      )}
      <div className="form-row">
        <button type="button" className="btn-strong" disabled={busy} data-testid="brief-build" onClick={() => void build()}>
          {busy ? "…" : b ? "Build it again" : "Prepare for it"}
        </button>
      </div>
      {message && <p className="notice small" data-testid="brief-message" role="status">{message}</p>}
    </div>
  );
}

interface AfterDraft {
  decisions: Array<{ decision_text: string; decided_by?: string | null; source_quote?: string | null }>;
  commitments: Array<{ commitment_text: string; owner_side: "FIRM" | "COUNTERPARTY"; owed_by?: string | null; due_date?: string | null }>;
  open_questions: Array<{ question: string; owed_by_kind: string; owed_by?: string | null }>;
  stage_proposal?: { to_status: string; rationale: string } | null;
}

interface AfterResponse {
  decisions: Array<{ id: string; decision_text: string; decided_by: string | null; recorded_by_type: string }>;
  commitments: Array<{ id: string; commitment_text: string; owner_side: "FIRM" | "COUNTERPARTY"; owed_by: string | null; due_date: string | null; status: string; honoured_at: string | null; work_card_id: string | null }>;
  open_questions: Array<{ id: string; question: string; owed_by_kind: string; owed_by: string | null; state: string; answer: string | null }>;
  stage_proposals: Array<{ id: string; from_status: string; to_status: string; rationale: string; state: string; decision_note: string | null }>;
  artifacts: Array<{ id: string; kind: string; title: string; body_json: string; produced_by_type: string; created_at: string }>;
  latest_draft: { id: string; state: string; detail: string | null; drafted_by: string; draft_json: string; notes_read: number; created_at: string } | null;
  counts: { decisions: number; commitments_firm_open: number; commitments_counterparty_open: number; commitments_overdue: number; open_questions: number; stage_proposals_pending: number; artifacts: number };
}

function stageInWords(s: string): string {
  return s.toLowerCase().replace(/_/g, " ");
}

/** AFTER: the four objects, the artifacts, and the draft with the partner's button on it. */
export function AfterPanel({ meetingId, onChanged }: { meetingId: string; onChanged: () => void }): JSX.Element {
  const state = useApi<AfterResponse>(`/api/meetings/${meetingId}/after`, [meetingId]);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [answering, setAnswering] = useState<string | null>(null);
  const [answer, setAnswer] = useState("");
  const a = state.data;

  async function post(path: string, body: unknown, ok: number[], label: string, key: string) {
    setBusy(key);
    setMessage(null);
    const res = await api<{ error?: string; detail?: string }>(path, { method: "POST", body });
    setBusy(null);
    setMessage(ok.includes(res.status) ? `${label}.` : `${label} refused: ${res.data?.detail ?? res.data?.error ?? res.status}`);
    state.reload();
    onChanged();
  }

  let draft: AfterDraft | null = null;
  if (a?.latest_draft?.state === "DRAFTED") {
    try {
      draft = JSON.parse(a.latest_draft.draft_json) as AfterDraft;
    } catch {
      draft = null;
    }
  }

  return (
    <div data-testid={`after-${meetingId}`}>
      <h4>After: what came out of it</h4>

      <p className="small"><strong>Decided</strong></p>
      <ul className="card-list small" data-testid="after-decisions">
        {(a?.decisions ?? []).map((d) => (
          <li key={d.id} data-testid={`decision-${d.id}`}>{d.decision_text}{d.decided_by ? <span className="muted small"> — {d.decided_by}</span> : null}</li>
        ))}
        {a && a.decisions.length === 0 && <li className="state-empty" data-testid="no-decisions">Nothing has been recorded as settled.</li>}
      </ul>

      <p className="small"><strong>Owed — both sides</strong></p>
      <ul className="card-list small" data-testid="after-commitments">
        {(a?.commitments ?? []).map((c) => (
          <li key={c.id} data-testid={`after-commitment-${c.id}`}>
            <span className="help-tag help-tag-muted">{c.owner_side === "FIRM" ? "we owe" : "they owe"}</span> {c.commitment_text}
            {c.owed_by ? <span className="muted small"> — {c.owed_by}</span> : null}
            {c.due_date ? <span className="muted small"> · due {c.due_date.slice(0, 10)}</span> : null}{" "}
            {c.honoured_at ? (
              <span className="help-tag help-tag-good">delivered</span>
            ) : c.status === "CONVERTED" ? (
              <span className="help-tag help-tag-good">on a work card</span>
            ) : c.status === "DROPPED" ? (
              <span className="help-tag help-tag-muted">dropped</span>
            ) : (
              <button type="button" className="link-button" disabled={busy === c.id} data-testid={`honour-${c.id}`} onClick={() => void post(`/api/meeting-commitments/${c.id}/honour`, {}, [200], "Marked as delivered", c.id)}>
                It was delivered
              </button>
            )}
          </li>
        ))}
        {a && a.commitments.length === 0 && <li className="state-empty" data-testid="no-after-commitments">Nothing is owed either way.</li>}
      </ul>

      <p className="small"><strong>Still unknown</strong></p>
      <ul className="card-list small" data-testid="after-open-questions">
        {(a?.open_questions ?? []).map((q) => (
          <li key={q.id} data-testid={`open-question-${q.id}`}>
            {q.question}
            {q.owed_by ? <span className="muted small"> — {q.owed_by}</span> : null}{" "}
            {q.state === "ANSWERED" ? (
              <span className="help-tag help-tag-good">answered: {q.answer}</span>
            ) : q.state === "WITHDRAWN" ? (
              <span className="help-tag help-tag-muted">withdrawn</span>
            ) : answering === q.id ? (
              <span className="form-row">
                <input value={answer} onChange={(e) => setAnswer(e.target.value)} data-testid={`answer-text-${q.id}`} placeholder="what we found out" aria-label="The answer" />
                <button type="button" className="btn-strong" disabled={answer.trim().length < 3} data-testid={`answer-save-${q.id}`} onClick={() => { void post(`/api/meeting-open-questions/${q.id}/resolve`, { state: "ANSWERED", answer: answer.trim() }, [200], "Answered", q.id); setAnswering(null); setAnswer(""); }}>
                  Record the answer
                </button>
                <button type="button" onClick={() => { setAnswering(null); setAnswer(""); }}>Not now</button>
              </span>
            ) : (
              <button type="button" className="link-button" data-testid={`answer-${q.id}`} onClick={() => { setAnswering(q.id); setAnswer(""); }}>
                Answer it
              </button>
            )}
          </li>
        ))}
        {a && a.open_questions.length === 0 && <li className="state-empty" data-testid="no-open-questions">Nothing was left open.</li>}
      </ul>

      <p className="small"><strong>What this means for the deal</strong></p>
      <ul className="card-list small" data-testid="after-stage-proposals">
        {(a?.stage_proposals ?? []).map((p) => (
          <li key={p.id} data-testid={`stage-proposal-${p.id}`}>
            Move the deal from {stageInWords(p.from_status)} to <strong>{stageInWords(p.to_status)}</strong> — {p.rationale}{" "}
            {p.state === "PROPOSED" ? (
              <span className="form-row">
                <button type="button" className="btn-strong" disabled={busy === p.id} data-testid={`stage-accept-${p.id}`} onClick={() => void post(`/api/meeting-stage-proposals/${p.id}/decide`, { decision: "ACCEPT" }, [200], "Moved", p.id)}>
                  Move it
                </button>
                <button type="button" disabled={busy === p.id} data-testid={`stage-decline-${p.id}`} onClick={() => void post(`/api/meeting-stage-proposals/${p.id}/decide`, { decision: "DECLINE", note: "Declined on the meeting record." }, [200], "Declined", p.id)}>
                  Leave it where it is
                </button>
              </span>
            ) : (
              <span className={p.state === "ACCEPTED" ? "help-tag help-tag-good" : "help-tag help-tag-muted"}>{p.state === "ACCEPTED" ? "moved" : "left where it was"}</span>
            )}
          </li>
        ))}
        {a && a.stage_proposals.length === 0 && <li className="state-empty" data-testid="no-stage-proposals">No stage change has been proposed. A proposal is never acted on without your click.</li>}
      </ul>

      <p className="small"><strong>Saved from the room</strong></p>
      <ul className="card-list small" data-testid="after-artifacts">
        {(a?.artifacts ?? []).map((art) => (
          <li key={art.id} data-testid={`artifact-${art.id}`}>
            <span className="help-tag help-tag-muted">{art.kind}</span> <strong>{art.title}</strong>
            <pre className="block-raw-text">{art.body_json}</pre>
          </li>
        ))}
        {a && a.artifacts.length === 0 && <li className="state-empty" data-testid="no-artifacts">Nothing was saved from the room. The live room writes these.</li>}
      </ul>

      <p className="small"><strong>The draft</strong></p>
      {a?.latest_draft && a.latest_draft.state !== "DRAFTED" && (
        <p className="muted small" data-testid="draft-state">
          {a.latest_draft.drafted_by}'s last draft {a.latest_draft.state === "APPROVED" ? "was approved" : a.latest_draft.state === "DISCARDED" ? "was set aside" : a.latest_draft.state === "REFUSED" ? "was refused" : "failed"}
          {a.latest_draft.detail ? ` — ${a.latest_draft.detail}` : "."}
        </p>
      )}
      {a && !a.latest_draft && <p className="state-empty" data-testid="no-draft">No draft yet. {`The type's lead employee can read the notes and propose the four things above.`}</p>}
      {draft && a?.latest_draft && (
        <div className="card" data-testid="draft">
          <p className="muted small">
            {a.latest_draft.drafted_by} read {a.latest_draft.notes_read} note(s) and proposes: {draft.decisions.length} decision(s), {draft.commitments.length} commitment(s), {draft.open_questions.length} open question(s){draft.stage_proposal ? `, and a move to ${stageInWords(draft.stage_proposal.to_status)}` : ""}. Nothing is a record until you approve it.
          </p>
          {a.latest_draft.detail && <p className="notice small">{a.latest_draft.detail}</p>}
          <ul className="card-list small">
            {draft.decisions.map((d, i) => <li key={`d${i}`}><span className="help-tag help-tag-muted">decided</span> {d.decision_text}</li>)}
            {draft.commitments.map((c, i) => <li key={`c${i}`}><span className="help-tag help-tag-muted">{c.owner_side === "FIRM" ? "we owe" : "they owe"}</span> {c.commitment_text}{c.owed_by ? ` — ${c.owed_by}` : ""}</li>)}
            {draft.open_questions.map((q, i) => <li key={`q${i}`}><span className="help-tag help-tag-muted">open</span> {q.question}</li>)}
            {draft.stage_proposal && <li><span className="help-tag help-tag-warn">proposed</span> move to {stageInWords(draft.stage_proposal.to_status)} — {draft.stage_proposal.rationale}</li>}
          </ul>
          <div className="form-row">
            <button type="button" className="btn-strong" disabled={busy === a.latest_draft.id} data-testid="draft-approve" onClick={() => void post(`/api/meeting-after-drafts/${a.latest_draft!.id}/approve`, {}, [200], "Approved and recorded", a.latest_draft!.id)}>
              Approve — make these the record
            </button>
            <button type="button" disabled={busy === a.latest_draft.id} data-testid="draft-discard" onClick={() => void post(`/api/meeting-after-drafts/${a.latest_draft!.id}/discard`, {}, [200], "Set aside", a.latest_draft!.id)}>
              Set it aside
            </button>
          </div>
        </div>
      )}
      <div className="form-row">
        <button type="button" disabled={busy === "draft"} data-testid="draft-run" onClick={() => void post(`/api/meetings/${meetingId}/after-draft`, {}, [200, 201], "Draft ready", "draft")}>
          {busy === "draft" ? "…" : "Draft what came out of it"}
        </button>
      </div>
      {message && <p className="notice small" data-testid="after-message" role="status">{message}</p>}
    </div>
  );
}
