import { useState, type ReactNode } from "react";
import { api, useApi } from "../lib/api";
import type { MaterialSource } from "@shared/meetings/howTheRoomHears";
import { CallDoors, ONE_ROOM_LINE } from "./CallDoors";
import { ArtifactShelf } from "./ArtifactShelf";

/**
 * The BEFORE and AFTER faces of a meeting on its record (Phase B data, Phase D shape — §3, C1/C3).
 *
 * The rule the panels keep: a draft is a proposal, the four objects are records, and the button
 * between them is the partner's. The one model-written line — the brief's why-line — sits at rank
 * 0 on Before with an eyebrow saying who wrote it and what it examined; everything under it is the
 * record. On After the answer line is the draft's own sentence, the stage proposal is a direct
 * click (owner's decision Q2, 18 Sep 2026 — `decideStageProposal` is `transitionOpportunity`, a
 * person's act already), and approving the draft is the one human card a meeting costs.
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

function standingClass(s: BriefCommitmentLine["standing"]): string {
  switch (s) {
    case "OVERDUE": return "badge badge-bad";
    case "DELIVERED":
    case "CONVERTED": return "badge badge-ok";
    default: return "badge";
  }
}

function stageInWords(s: string): string {
  return s.toLowerCase().replace(/_/g, " ");
}

function whenInWords(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The owner asked whether the second "Open the room" was "a real room". It is the During face of
 * this same meeting — the tab above — and the line under the button says so, rather than leaving a
 * button at the end of the brief to be guessed at.
 */
const OPEN_THE_ROOM_LINE = "Goes to During — the same room, not a second one: the recording switch, ask the room, who is seated. For a meeting with a call, the call's doors are here instead.";

/** "Meet transcript · read Thu 18 Sep 11:04 · 212 turns" — where After's material came from. */
function sourceInWords(s: MaterialSource): string {
  const when = s.first_at && s.last_at && s.first_at !== s.last_at ? `${whenInWords(s.first_at)} → ${whenInWords(s.last_at)}` : whenInWords(s.last_at ?? s.first_at ?? "");
  const what =
    s.kind === "laptop_capture" ? `${count(s.count, "minute", "minutes")} captured` :
    s.kind === "meet_transcript" ? "read from Google" :
    s.kind === "typed_notes" ? count(s.count, "note", "notes") :
    s.kind === "room_blocks" ? count(s.count, "block", "blocks") :
    count(s.count, "import", "imports");
  const turns = s.turns !== null && s.kind !== "typed_notes" && s.kind !== "room_blocks" ? ` · ${count(s.turns, "turn", "turns")}` : "";
  return `${what}${turns} · ${when}`;
}

/** A "we said" / "they said" line with its standing beside it. */
function CommitmentLine({ c }: { c: BriefCommitmentLine }): JSX.Element {
  return (
    <li>
      {c.text}
      {c.owed_by ? <span className="muted small"> — {c.owed_by}</span> : null}{" "}
      <span className={standingClass(c.standing)}>
        {standingInWords(c.standing)}
        {c.due_date ? ` · due ${c.due_date.slice(0, 10)}` : ""}
      </span>
    </li>
  );
}

interface DiligenceResponse {
  framework: { core: Array<{ id: string; title: string; mandatory: boolean }>; sector: { sector: string; title: string } | null };
  answers: Array<{ section_id: string; state: string }>;
}

/** The diligence framework as the checkbox list it always was, read off the packet when one exists. */
function DiligenceScorecard({ packetId }: { packetId: string }): JSX.Element {
  const d = useApi<DiligenceResponse>(`/api/ic/packets/${packetId}/diligence`, [packetId]);
  const answers = new Map((d.data?.answers ?? []).map((a) => [a.section_id, a.state]));
  const sections = d.data?.framework.core ?? [];
  if (d.loading && sections.length === 0) return <p className="state-empty">Reading the framework…</p>;
  if (sections.length === 0) return <p className="state-empty">The packet's framework could not be read (HTTP {d.status ?? "—"}).</p>;
  return (
    <ul className="scorecard" data-testid="brief-scorecard">
      {sections.map((s) => {
        const state = answers.get(s.id) ?? "OPEN";
        const on = state === "ANSWERED" || state === "NOT_APPLICABLE";
        return (
          <li key={s.id}>
            <span className="check"><i className={on ? "on" : ""} aria-hidden="true" />{s.title}</span>
            <span className="muted small">{state === "ANSWERED" ? "answered" : state === "NOT_APPLICABLE" ? "not applicable" : "open"}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** BEFORE: the brief, with its one model-written line at rank 0, or a named absence and the button that builds one. */
export function BeforePanel({ meetingId, meetLink = null, onChanged, seating, onOpenRoom, onNavigate }: {
  meetingId: string;
  /** The Meet link, when the calendar brought one: the doors onto the call replace Open the room. */
  meetLink?: string | null;
  onChanged: () => void;
  seating: ReactNode;
  onOpenRoom: () => void;
  onNavigate: (key: string) => void;
}): JSX.Element {
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
    else setMessage("Brief built. The eyebrow says what it examined.");
    state.reload();
    onChanged();
  }

  const coverage = b ? b.coverage.map((c) => `${c.source} (${c.rowsRead})`).join(" · ") : "";
  const findOutOwed = b ? b.find_out.length : 0;

  return (
    <div data-testid={`before-${meetingId}`} className="stack">
      {/*
        RANK 0 IS THE MODEL'S ONE LINE, AND THE EYEBROW SAYS SO. The why-line is the only sentence on
        this face a model wrote; who wrote it and what it read sit directly above it, and the detail
        under it says that everything else is the record. When the line could not be written, the
        answer slot says that — a named absence, never a blank that reads as "nothing to say".
      */}
      <div className="masthead" data-testid="brief-masthead">
        <p className="masthead-date" data-testid="brief-coverage">
          {b
            ? `The brief · prepared by ${b.prepared_by}, ${whenInWords(state.data!.brief!.created_at)} · examined ${coverage || "nothing"}${b.unreadable.length > 0 ? ` · could not read: ${b.unreadable.join(", ")}` : ""}`
            : state.loading && !state.data
              ? "The brief"
              : "No brief yet"}
        </p>
        <h2 data-testid="brief-why">
          {b
            ? b.why ?? `No line could be written — ${b.why_unavailable ?? "no reason given"}.`
            : state.loading && !state.data
              ? "Reading the brief…"
              : state.data?.note ?? "No brief has been built for this meeting."}
        </h2>
        <p className="masthead-second">
          {b
            ? b.why
              ? `The one line above is ${b.prepared_by}'s; everything below is the record.`
              : `${b.prepared_by} read the record and could not say why this meeting exists. Everything below is the record.`
            : "Build it and it says what it examined. It is built the night before on its own; this is the door for a meeting that cannot wait."}
        </p>
      </div>

      {state.data && !b && (
        <p className="state-empty" data-testid="brief-none">{state.data.note ?? "No brief yet."}</p>
      )}

      {b && (
        <div className="room-grid" data-testid="brief">
          <div className="stack">
            <section className="card">
              <div className="panel-head">
                <h3>What we need to find out</h3>
                <span className="muted small">{findOutOwed === 0 ? "nothing carried forward" : count(findOutOwed, "question", "questions")}</span>
              </div>
              <ol className="card-list" data-testid="brief-find-out">
                {b.find_out.map((q) => <li key={q.sourceId + q.text}><strong>{q.text}</strong></li>)}
                {b.find_out.length === 0 && <li className="state-empty">No open questions are carried forward.</li>}
              </ol>
            </section>

            <section className="card">
              <div className="panel-head">
                <h3>What we said last time</h3>
                <span className="muted small">{b.last_time.firm[0]?.meeting_title ?? b.last_time.counterparty[0]?.meeting_title ?? "no earlier meeting on record"}</span>
              </div>
              {b.last_time.firm.length + b.last_time.counterparty.length === 0 ? (
                <p className="state-empty" data-testid="brief-last-time">Nothing is on record from an earlier meeting with them.</p>
              ) : (
                <div className="two-col" data-testid="brief-last-time">
                  <div>
                    <p className="eyebrow">We said we would</p>
                    <ul className="card-list">
                      {b.last_time.firm.map((c) => <CommitmentLine key={c.sourceId} c={c} />)}
                      {b.last_time.firm.length === 0 && <li className="state-empty">Nothing.</li>}
                    </ul>
                  </div>
                  <div>
                    <p className="eyebrow">They said they would</p>
                    <ul className="card-list">
                      {b.last_time.counterparty.map((c) => <CommitmentLine key={c.sourceId} c={c} />)}
                      {b.last_time.counterparty.length === 0 && <li className="state-empty">Nothing.</li>}
                    </ul>
                  </div>
                </div>
              )}
            </section>

            <section className="card">
              <div className="panel-head">
                <h3>The record</h3>
                {b.record.about === "COMPANY" && (
                  <button type="button" className="btn-ghost" onClick={() => onNavigate("dealflow")}>Open the deal on Dealflow</button>
                )}
              </div>
              {b.record.about === "NOBODY" ? (
                <p className="muted small" data-testid="brief-record">This meeting is about neither a company nor an LP.</p>
              ) : (
                <dl className="dl" data-testid="brief-record">
                  <div><dt>{b.record.about === "COMPANY" ? "Company" : "LP"}</dt><dd>{b.record.name ?? "—"}</dd></div>
                  <div><dt>Where it is</dt><dd>{b.record.stage ? stageInWords(b.record.stage) : "—"}</dd></div>
                  <div><dt>What they do</dt><dd>{b.record.summary ?? "—"}</dd></div>
                  <div><dt>Touches on the record</dt><dd>{b.record.touches.length}</dd></div>
                </dl>
              )}
            </section>
          </div>

          <div className="stack">
            <section className="card">
              <div className="panel-head">
                <h3>Diligence framework</h3>
                <span className="muted small" data-testid="brief-diligence">
                  {b.diligence ? `${b.diligence.answered} answered · ${b.diligence.unanswered} open` : "not a deal meeting"}
                </span>
              </div>
              {b.diligence?.packet_id ? (
                <DiligenceScorecard packetId={b.diligence.packet_id} />
              ) : (
                <p className="muted small">
                  {b.diligence ? "No IC packet exists yet, so the framework is unanswered. It opens when the deal reaches the committee stage." : "The framework applies to a company; this meeting is not about one."}
                </p>
              )}
            </section>

            {seating}

            {/*
              ONE ROOM, SEVERAL DOORS. With a call, the doors onto it stand here (Join on Meet inside
              or beside, the laptop mic) and she never presses Open the room after choosing one.
              Without a call — reading the brief, in person — Open the room goes to During.
            */}
            {meetLink ? (
              <div className="stack">
                <p className="field-help">{ONE_ROOM_LINE}</p>
                <CallDoors meeting={{ id: meetingId, meet_link: meetLink }} />
                <button type="button" className="btn-ghost" disabled={busy} data-testid="brief-build" onClick={() => void build()}>
                  {busy ? "Building…" : "Build the brief again"}
                </button>
              </div>
            ) : (
              <>
                <div className="row">
                  <button type="button" className="btn-strong btn-lg" data-testid="brief-open-room" onClick={onOpenRoom}>Open the room</button>
                  <button type="button" className="btn-ghost" disabled={busy} data-testid="brief-build" onClick={() => void build()}>
                    {busy ? "Building…" : "Build the brief again"}
                  </button>
                </div>
                <p className="field-help" data-testid="brief-open-room-line">{OPEN_THE_ROOM_LINE}</p>
              </>
            )}
          </div>
        </div>
      )}

      {!b && (
        <div className="stack">
          {seating}
          <div className="row">
            <button type="button" className="btn-strong btn-lg" disabled={busy || (state.loading && !state.data)} data-testid="brief-build" onClick={() => void build()}>
              {busy ? "Building…" : "Prepare for it"}
            </button>
            {!meetLink && <button type="button" data-testid="brief-open-room" onClick={onOpenRoom}>Open the room</button>}
          </div>
          {meetLink ? (
            <div className="stack">
              <p className="field-help">{ONE_ROOM_LINE}</p>
              <CallDoors meeting={{ id: meetingId, meet_link: meetLink }} />
            </div>
          ) : (
            <p className="field-help" data-testid="brief-open-room-line">{OPEN_THE_ROOM_LINE}</p>
          )}
        </div>
      )}
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

interface AfterCommitment {
  id: string;
  commitment_text: string;
  owner_side: "FIRM" | "COUNTERPARTY";
  owed_by: string | null;
  due_date: string | null;
  status: string;
  honoured_at: string | null;
  work_card_id: string | null;
}

interface AfterResponse {
  decisions: Array<{ id: string; decision_text: string; decided_by: string | null; recorded_by_type: string }>;
  commitments: AfterCommitment[];
  open_questions: Array<{ id: string; question: string; owed_by_kind: string; owed_by: string | null; state: string; answer: string | null }>;
  stage_proposals: Array<{ id: string; from_status: string; to_status: string; rationale: string; state: string; decision_note: string | null }>;
  artifacts: Array<{ id: string; kind: string; title: string; body_json: string; produced_by_type: string; created_at: string }>;
  latest_draft: { id: string; state: string; detail: string | null; drafted_by: string; draft_json: string; notes_read: number; created_at: string } | null;
  counts: { decisions: number; commitments_firm_open: number; commitments_counterparty_open: number; commitments_overdue: number; open_questions: number; stage_proposals_pending: number; artifacts: number };
}

/** "Two decisions, three commitments, two open questions, and a move to diligence." */
function sentenceOf(decisions: number, commitments: number, questions: number, move: string | null): string {
  const parts = [count(decisions, "decision", "decisions"), count(commitments, "commitment", "commitments"), count(questions, "open question", "open questions")];
  const head = `${parts[0]}, ${parts[1]}, ${move ? parts[2] : `and ${parts[2]}`}`;
  return `${head.charAt(0).toUpperCase()}${head.slice(1)}${move ? `, and a move to ${stageInWords(move)}` : ""}.`;
}

/** AFTER: the four objects, the artifacts, who is holding what, and the draft with the partner's button on it. */
export function AfterPanel({ meetingId, onChanged, closeout }: { meetingId: string; onChanged: () => void; closeout: ReactNode }): JSX.Element {
  const state = useApi<AfterResponse>(`/api/meetings/${meetingId}/after`, [meetingId]);
  const hearing = useApi<{ sources: MaterialSource[] }>(`/api/meetings/${meetingId}/hearing`, [meetingId]);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [answering, setAnswering] = useState<string | null>(null);
  const [answer, setAnswer] = useState("");
  const [commitmentText, setCommitmentText] = useState("");
  const a = state.data;

  async function post(path: string, body: unknown, ok: number[], label: string, key: string) {
    setBusy(key);
    setMessage(null);
    const res = await api<{ error?: string; detail?: string }>(path, { method: "POST", body });
    setBusy(null);
    setMessage(ok.includes(res.status) ? `${label}.` : `${label} refused: ${res.data?.detail ?? res.data?.error ?? res.status}`);
    state.reload();
    hearing.reload();
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

  const pending = (a?.stage_proposals ?? []).filter((p) => p.state === "PROPOSED");
  const decided = (a?.stage_proposals ?? []).filter((p) => p.state !== "PROPOSED");
  const we = (a?.commitments ?? []).filter((c) => c.owner_side === "FIRM");
  const they = (a?.commitments ?? []).filter((c) => c.owner_side === "COUNTERPARTY");

  // Rank 0: the draft's own sentence while one waits; the record's sentence once it is the record.
  let eyebrow = "What came out of it";
  let answerLine = "Reading the record…";
  let detail = "";
  if (a) {
    if (draft && a.latest_draft) {
      eyebrow = `${a.latest_draft.drafted_by} read ${count(a.latest_draft.notes_read, "note", "notes")} · drafted ${whenInWords(a.latest_draft.created_at)} · nothing below is a record until you approve it`;
      answerLine = sentenceOf(draft.decisions.length, draft.commitments.length, draft.open_questions.length, draft.stage_proposal?.to_status ?? null);
      detail = "One approval makes all of it the record. The stage move is its own click, here or on Dealflow.";
    } else if (a.decisions.length + a.commitments.length + a.open_questions.length + a.stage_proposals.length > 0) {
      eyebrow = `On the record${a.latest_draft?.state === "APPROVED" ? ` · ${a.latest_draft.drafted_by}'s draft was approved` : ""}`;
      answerLine = sentenceOf(a.decisions.length, a.commitments.length, a.open_questions.filter((q) => q.state === "OPEN").length, pending[0]?.to_status ?? null);
      detail = pending.length > 0 ? "The stage move is waiting on your click below." : "Everything here is the record; what a partner honours is marked here, not on a work card.";
    } else {
      eyebrow = a.latest_draft ? `${a.latest_draft.drafted_by}'s last draft was ${a.latest_draft.state === "DISCARDED" ? "set aside" : a.latest_draft.state === "REFUSED" ? "refused" : "not usable"}` : "Nothing yet";
      answerLine = "Nothing has come out of this meeting yet.";
      detail = a.latest_draft?.detail ?? "Draft it from the notes and the room, or record what was owed by hand below.";
    }
  }

  return (
    <div data-testid={`after-${meetingId}`} className="stack">
      <div className="masthead" data-testid="after-masthead">
        <p className="masthead-date">{eyebrow}</p>
        <h2 data-testid="after-answer">{answerLine}</h2>
        {detail && <p className="masthead-second">{detail}</p>}
      </div>

      {/*
        WHERE THE MATERIAL CAME FROM (owner, 19 Sep 2026). A draft written from Google's transcript
        of the call, from the laptop's minute-by-minute capture, or from three typed lines reads the
        same on the page; the eyebrow above says how many notes were read, not what they were. This
        says it, by origin, with the times, from `/hearing` — one route the During face shares.
      */}
      <div className="hears" data-testid="after-sources" data-state={hearing.data ? (hearing.data.sources.length === 0 ? "empty" : "ready") : hearing.loading ? "loading" : "error"}>
        <span className="eyebrow">Where this came from</span>
        {!hearing.data ? (
          <span className="muted small">{hearing.loading ? "Reading where the material came from…" : `Could not read where the material came from (HTTP ${hearing.status ?? "—"}).`}</span>
        ) : hearing.data.sources.length === 0 ? (
          <span className="muted small" data-testid="after-sources-empty">Nothing has reached this record yet — no Meet transcript, no laptop capture, no typed notes.</span>
        ) : (
          <ul className="card-list small" data-testid="after-sources-list">
            {hearing.data.sources.map((src) => (
              <li key={src.kind} data-testid={`after-source-${src.kind}`}><strong>{src.label}</strong> · {sourceInWords(src)}</li>
            ))}
          </ul>
        )}
      </div>

      {a?.latest_draft && a.latest_draft.state !== "DRAFTED" && a.latest_draft.state !== "APPROVED" && (
        <p className="muted small" data-testid="draft-state">
          {a.latest_draft.drafted_by}'s last draft {a.latest_draft.state === "DISCARDED" ? "was set aside" : a.latest_draft.state === "REFUSED" ? "was refused" : "failed"}
          {a.latest_draft.detail ? ` — ${a.latest_draft.detail}` : "."}
        </p>
      )}

      {/*
        THE STAGE MOVE IS A CLICK, NOT A CARD (owner, Q2). `decideStageProposal` calls
        `transitionOpportunity`, which is the same act a partner makes on Dealflow; a card on top of
        it would be a second signature for one decision. The banner carries the page's one primary.
      */}
      <ul className="card-list stack" data-testid="after-stage-proposals">
        {pending.map((p) => (
          <li key={p.id} className="card watch-banner" data-testid={`stage-proposal-${p.id}`}>
            <div className="row between">
              <div className="grow">
                <p className="eyebrow">What this means for the deal</p>
                <p><strong>Move the deal from {stageInWords(p.from_status)} to {stageInWords(p.to_status)}</strong> — {p.rationale}</p>
              </div>
              <div className="deal-actions">
                <button type="button" className="btn-primary" disabled={busy === p.id} data-testid={`stage-accept-${p.id}`} onClick={() => void post(`/api/meeting-stage-proposals/${p.id}/decide`, { decision: "ACCEPT" }, [200], "Moved", p.id)}>
                  Move it
                </button>
                <button type="button" disabled={busy === p.id} data-testid={`stage-decline-${p.id}`} onClick={() => void post(`/api/meeting-stage-proposals/${p.id}/decide`, { decision: "DECLINE", note: "Declined on the meeting record." }, [200], "Declined", p.id)}>
                  Leave it where it is
                </button>
              </div>
            </div>
          </li>
        ))}
        {decided.map((p) => (
          <li key={p.id} className="muted small" data-testid={`stage-proposal-${p.id}`}>
            Move from {stageInWords(p.from_status)} to {stageInWords(p.to_status)} — {p.rationale}{" "}
            <span className={p.state === "ACCEPTED" ? "badge badge-ok" : "badge"}>{p.state === "ACCEPTED" ? "moved" : "left where it was"}</span>
          </li>
        ))}
        {a && a.stage_proposals.length === 0 && (
          <li className="muted small" data-testid="no-stage-proposals">No stage change has been proposed. A proposal is never acted on without your click.</li>
        )}
      </ul>

      <div className="two-col">
        <section className="card">
          <div className="panel-head">
            <h3>Decided</h3>
            <span className="muted small">{a ? a.decisions.length : "…"}</span>
          </div>
          <ul className="card-list" data-testid="after-decisions">
            {(a?.decisions ?? []).map((d) => (
              <li key={d.id} data-testid={`decision-${d.id}`}>{d.decision_text}{d.decided_by ? <span className="muted small"> — {d.decided_by}</span> : null}</li>
            ))}
            {a && a.decisions.length === 0 && <li className="state-empty" data-testid="no-decisions">Nothing has been recorded as settled.</li>}
          </ul>
        </section>

        <section className="card">
          <div className="panel-head">
            <h3>Still unknown</h3>
            <span className="muted small">{a ? a.open_questions.filter((q) => q.state === "OPEN").length : "…"}</span>
          </div>
          <ul className="card-list" data-testid="after-open-questions">
            {(a?.open_questions ?? []).map((q) => (
              <li key={q.id} data-testid={`open-question-${q.id}`}>
                {q.question}
                {q.owed_by ? <span className="muted small"> — owed by {q.owed_by}</span> : null}{" "}
                {q.state === "ANSWERED" ? (
                  <span className="badge badge-ok">answered: {q.answer}</span>
                ) : q.state === "WITHDRAWN" ? (
                  <span className="badge">withdrawn</span>
                ) : answering === q.id ? (
                  <span className="form-row">
                    <input value={answer} onChange={(e) => setAnswer(e.target.value)} data-testid={`answer-text-${q.id}`} placeholder="what we found out" aria-label="The answer" />
                    <button type="button" className="btn-strong" disabled={answer.trim().length < 3} data-testid={`answer-save-${q.id}`} onClick={() => { void post(`/api/meeting-open-questions/${q.id}/resolve`, { state: "ANSWERED", answer: answer.trim() }, [200], "Answered", q.id); setAnswering(null); setAnswer(""); }}>
                      Record the answer
                    </button>
                    <button type="button" onClick={() => { setAnswering(null); setAnswer(""); }}>Not now</button>
                  </span>
                ) : (
                  <button type="button" className="btn-ghost" data-testid={`answer-${q.id}`} onClick={() => { setAnswering(q.id); setAnswer(""); }}>
                    Answer it
                  </button>
                )}
              </li>
            ))}
            {a && a.open_questions.length === 0 && <li className="state-empty" data-testid="no-open-questions">Nothing was left open.</li>}
          </ul>
        </section>
      </div>

      <section className="card">
        <div className="panel-head">
          <h3>Owed — both sides</h3>
          <span className="muted small">{a ? `${a.commitments.length} · what a partner honours is marked here, not on a work card` : "…"}</span>
        </div>
        <div className="two-col">
          <div>
            <p className="eyebrow">We owe them</p>
            <ul className="card-list" data-testid="commitment-list">
              {we.map((c) => <OwedLine key={c.id} c={c} busy={busy} post={post} />)}
              {a && we.length === 0 && <li className="state-empty" data-testid="no-after-commitments">Nothing is owed by the firm.</li>}
            </ul>
          </div>
          <div>
            <p className="eyebrow">They owe us</p>
            <ul className="card-list" data-testid="counterparty-commitment-list">
              {they.map((c) => <OwedLine key={c.id} c={c} busy={busy} post={post} />)}
              {a && they.length === 0 && <li className="state-empty">Nothing is owed to the firm.</li>}
            </ul>
          </div>
        </div>
        {/* A promise recorded by hand: the firm's side, converted into a work card from its row. */}
        <form
          className="form-row"
          data-testid="commitment-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (commitmentText.trim().length < 3) return;
            await post(`/api/meetings/${meetingId}/commitments`, { commitment_text: commitmentText.trim(), owner_side: "FIRM" }, [201], "Recorded", "commitment");
            setCommitmentText("");
          }}
        >
          <label>
            We owe them{" "}
            <input data-testid="commitment-text" value={commitmentText} onChange={(e) => setCommitmentText(e.target.value)} placeholder="send the diligence question list" />
          </label>
          <button type="submit" className="btn-strong" disabled={busy === "commitment" || commitmentText.trim().length < 3} data-testid="commitment-submit">Record it</button>
        </form>
      </section>

      <section className="card">
        <div className="panel-head">
          <h3>Saved from the room</h3>
          <span className="muted small">{a ? count(a.artifacts.length, "block", "blocks") : "…"}</span>
        </div>
        <ul className="card-list stack" data-testid="after-artifacts">
          {(a?.artifacts ?? []).map((art) => (
            <li key={art.id} className="artifact" data-testid={`artifact-${art.id}`}>
              <div className="artifact-kind"><span>{art.kind}</span><span className="muted">{whenInWords(art.created_at)}</span></div>
              <strong>{art.title}</strong>
              <details>
                <summary className="muted small">What it holds</summary>
                <pre className="block-raw-text">{art.body_json}</pre>
              </details>
            </li>
          ))}
          {a && a.artifacts.length === 0 && <li className="state-empty" data-testid="no-artifacts">Nothing was saved from the room. The live room writes these.</li>}
        </ul>
        {/* What the room BUILT — dashboards, decks, documents — lives on the company or LP this
            meeting is about and under Documents; these are the link rows. */}
        <h4>Built from this meeting</h4>
        <ArtifactShelf about={meetingId} showObject emptyNote="Nothing was built from this meeting. In the room, say “make this a dashboard” over a table, or ask for a deck or a one-pager." testId="after-built-rows" />
      </section>

      {closeout}

      <section className="card" data-testid="draft-card">
        <div className="panel-head">
          <h3>The draft</h3>
          <span className="muted small">{draft ? "a proposal until you approve it" : "what the lead employee proposes from the notes"}</span>
        </div>
        {a && !a.latest_draft && <p className="state-empty" data-testid="no-draft">No draft yet. The type's lead employee can read the notes and propose the four things above.</p>}
        {draft && a?.latest_draft && (
          <div className="stack" data-testid="draft">
            <p className="muted small">
              {a.latest_draft.drafted_by} read {count(a.latest_draft.notes_read, "note", "notes")} and proposes: {draft.decisions.length} decision(s), {draft.commitments.length} commitment(s), {draft.open_questions.length} open question(s){draft.stage_proposal ? `, and a move to ${stageInWords(draft.stage_proposal.to_status)}` : ""}. Nothing is a record until you approve it.
            </p>
            {a.latest_draft.detail && <p className="notice small">{a.latest_draft.detail}</p>}
            <ul className="card-list small">
              {draft.decisions.map((d, i) => <li key={`d${i}`}><span className="badge">decided</span> {d.decision_text}</li>)}
              {draft.commitments.map((c, i) => <li key={`c${i}`}><span className="badge">{c.owner_side === "FIRM" ? "we owe" : "they owe"}</span> {c.commitment_text}{c.owed_by ? ` — ${c.owed_by}` : ""}</li>)}
              {draft.open_questions.map((q, i) => <li key={`q${i}`}><span className="badge">open</span> {q.question}</li>)}
              {draft.stage_proposal && <li><span className="badge badge-gate">proposed</span> move to {stageInWords(draft.stage_proposal.to_status)} — {draft.stage_proposal.rationale}</li>}
            </ul>
          </div>
        )}
        <div className="row">
          {draft && a?.latest_draft ? (
            <>
              <button type="button" className="btn-strong" disabled={busy === a.latest_draft.id} data-testid="draft-approve" onClick={() => void post(`/api/meeting-after-drafts/${a.latest_draft!.id}/approve`, {}, [200], "Approved and recorded", a.latest_draft!.id)}>
                Approve — make these the record
              </button>
              <button type="button" disabled={busy === a.latest_draft.id} data-testid="draft-discard" onClick={() => void post(`/api/meeting-after-drafts/${a.latest_draft!.id}/discard`, {}, [200], "Set aside", a.latest_draft!.id)}>
                Set it aside
              </button>
              <span className="muted small">Approving is one human card. The stage move above is not.</span>
            </>
          ) : (
            <button type="button" className="btn-strong" disabled={busy === "draft"} data-testid="draft-run" onClick={() => void post(`/api/meetings/${meetingId}/after-draft`, {}, [200, 201], "Draft ready", "draft")}>
              {busy === "draft" ? "Reading the notes…" : "Draft what came out of it"}
            </button>
          )}
        </div>
      </section>
      {message && <p className="notice small" data-testid="after-message" role="status">{message}</p>}
    </div>
  );
}

/** One owed line: its standing in words, and the act that changes it — delivered, or made into work. */
function OwedLine({ c, busy, post }: { c: AfterCommitment; busy: string | null; post: (path: string, body: unknown, ok: number[], label: string, key: string) => Promise<void> }): JSX.Element {
  return (
    <li data-testid={`after-commitment-${c.id}`}>
      {c.commitment_text}
      {c.owed_by ? <span className="muted small"> — {c.owed_by}</span> : null}
      {c.due_date ? <span className="muted small"> · due {c.due_date.slice(0, 10)}</span> : null}{" "}
      {c.honoured_at ? (
        <span className="badge badge-ok">delivered</span>
      ) : c.status === "CONVERTED" ? (
        <span className="badge badge-ok">on a work card</span>
      ) : c.status === "DROPPED" ? (
        <span className="badge">dropped</span>
      ) : (
        <>
          <button type="button" className="btn-ghost" disabled={busy === c.id} data-testid={`honour-${c.id}`} onClick={() => void post(`/api/meeting-commitments/${c.id}/honour`, {}, [200], "Marked as delivered", c.id)}>
            It was delivered
          </button>
          {c.owner_side === "FIRM" && (
            <button type="button" className="btn-ghost" disabled={busy === c.id} data-testid={`commitment-convert-${c.id}`} onClick={() => void post(`/api/meeting-commitments/${c.id}/convert`, {}, [200], "Made into a work card", c.id)}>
              Make it a work card
            </button>
          )}
        </>
      )}
    </li>
  );
}
