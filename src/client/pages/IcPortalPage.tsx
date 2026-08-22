import { useState } from "react";
import { api, useApi, type MeResponse } from "../lib/api";
import { actorName } from "@shared/help/actionNames";
import { HowThisWorks } from "./HowThisWorks";

/**
 * IC Decision Portal (P34, V1 #26, canon §28.6).
 *
 * Nine tabs, and the order is the argument: Company → Memo → Diligence → Market → People →
 * Live Help → Decision → Follow-Up → Audit. You build the case, you decide, you record what the
 * decision obliges, and the audit is permanent.
 *
 * The two things this page refuses to do, both deliberate:
 *
 *   NO COMPLETION PERCENTAGE. Readiness names the open sections. A number lets a packet read "92%"
 *   with the kill case empty, which is the failure the framework exists to prevent.
 *
 *   NO SILENT CHAMPION BEAR CASE. The bear-case fields are disabled for the named champion, with
 *   the reason shown. The server refuses it too — this is the courtesy, not the control.
 *
 * It is NOT a video room (V1 #26 is explicit). Live Help is the existing in-meeting chat.
 */

type Tab = "company" | "memo" | "diligence" | "market" | "people" | "live" | "decision" | "followup" | "audit";

const TABS: ReadonlyArray<{ key: Tab; label: string }> = [
  { key: "company", label: "Company" },
  { key: "memo", label: "Memo" },
  { key: "diligence", label: "Diligence" },
  { key: "market", label: "Market" },
  { key: "people", label: "People" },
  { key: "live", label: "Live Help" },
  { key: "decision", label: "Decision" },
  { key: "followup", label: "Follow-Up" },
  { key: "audit", label: "Audit" },
];

interface Section {
  id: string;
  title: string;
  intent: string;
  questions: string[];
  killer?: string;
  mandatory: boolean;
  championMayNotAnswer?: boolean;
}
interface SectorModule { sector: string; title: string; intent: string; questions: string[]; killer?: string }
interface AnswerRow { section_id: string; state: string; body: string | null; na_reason: string | null }
interface Readiness { open: string[]; answered: string[]; not_applicable: string[]; complete: boolean; bear_case_missing: boolean }

interface Rec {
  packet: Record<string, unknown>;
  company: { metrics: Array<Record<string, unknown>>; deal_math: Record<string, unknown> | null };
  memo: { claims: Array<Record<string, unknown>>; unsourced: number };
  market: Record<string, unknown> | null;
  people: Array<Record<string, unknown>>;
  decisions: Array<Record<string, unknown>>;
}

interface DiligenceResponse {
  packet: { id: string; sector: string; champion_user_id: string | null; status: string };
  framework: { core: Section[]; sector: SectorModule | null; closing_six: { n: number; question: string; championMayNotAnswer?: boolean }[] };
  answers: AnswerRow[];
  readiness: Readiness;
  restricted_section_ids: string[];
}

function SectionEditor({
  packetId, sectionId, title, intent, questions, killer, existing, locked, lockReason, onSaved,
}: {
  packetId: string; sectionId: string; title: string; intent?: string; questions?: string[];
  killer?: string; existing?: AnswerRow; locked: boolean; lockReason?: string; onSaved: () => void;
}): JSX.Element {
  const [body, setBody] = useState(existing?.body ?? "");
  const [naReason, setNaReason] = useState(existing?.na_reason ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const state = existing?.state ?? "OPEN";

  async function save(nextState: "ANSWERED" | "NOT_APPLICABLE") {
    setBusy(true); setErr(null);
    const res = await api<{ detail?: string; error?: string }>(`/api/ic/packets/${packetId}/diligence`, {
      method: "POST",
      body: { section_id: sectionId, state: nextState, body, na_reason: naReason },
    });
    if (res.status !== 201) setErr(res.data?.detail ?? res.data?.error ?? `Failed (HTTP ${res.status}).`);
    setBusy(false);
    onSaved();
  }

  return (
    <section className="card ic-section" data-testid={`ic-section-${sectionId}`}>
      <h4>
        {title}{" "}
        <span
          className={state === "ANSWERED" ? "help-tag help-tag-good" : state === "NOT_APPLICABLE" ? "help-tag help-tag-muted" : "help-tag help-tag-warn"}
          data-testid={`ic-state-${sectionId}`}
        >
          {state === "ANSWERED" ? "answered" : state === "NOT_APPLICABLE" ? "not applicable" : "open"}
        </span>
      </h4>
      {intent && <p className="muted small">{intent}</p>}

      {questions && questions.length > 0 && (
        <ul className="card-list small ic-questions">
          {questions.map((q) => <li key={q}>{q}</li>)}
        </ul>
      )}
      {killer && (
        <p className="ic-killer" data-testid={`ic-killer-${sectionId}`}>
          <strong>Killer question:</strong> {killer}
        </p>
      )}

      {locked ? (
        <p className="notice" data-testid={`ic-locked-${sectionId}`}>{lockReason}</p>
      ) : (
        <>
          <textarea
            aria-label="Section text" data-testid={`ic-body-${sectionId}`}
            rows={5}
            value={body}
            placeholder="What we found, and what we still don't know."
            onChange={(e) => setBody(e.target.value)}
          />
          <div className="form-row">
            <button type="button" className="btn-strong" disabled={busy} data-testid={`ic-save-${sectionId}`} onClick={() => save("ANSWERED")}>
              {busy ? "Saving…" : "Save answer"}
            </button>
            <label>
              Not applicable because{" "}
              <input
                data-testid={`ic-na-${sectionId}`}
                value={naReason}
                placeholder="reason"
                onChange={(e) => setNaReason(e.target.value)}
              />
            </label>
            <button type="button" disabled={busy || !naReason.trim()} data-testid={`ic-na-save-${sectionId}`} onClick={() => save("NOT_APPLICABLE")}>
              Mark n/a
            </button>
          </div>
          {err && <p className="notice" data-testid={`ic-error-${sectionId}`}>{err}</p>}
        </>
      )}
    </section>
  );
}

export function IcPortalPage({ packetId }: { packetId: string }): JSX.Element {
  const [tab, setTab] = useState<Tab>("diligence");
  // Self-contained: the champion rule needs to know who you are, and the panel that mounts this
  // does not have the current user. Fetching it here beats threading a prop through a parent that
  // has no other use for it.
  const me = useApi<MeResponse>("/api/me");
  const dil = useApi<DiligenceResponse>(`/api/ic/packets/${packetId}/diligence`, [packetId]);
  const audit = useApi<{ events: Array<{ event_type: string; actor_id: string; created_at: string }> }>(
    `/api/ic/packets/${packetId}/audit`, [packetId],
  );
  const follow = useApi<{ followups: Array<{ id: string; item_text: string; assignee_kind: string; state: string }> }>(
    `/api/ic/packets/${packetId}/followups`, [packetId],
  );
  // One request for the five record-backed tabs: they are five views of one deal, and five round
  // trips to render one screen is a slow screen.
  const records = useApi<Rec>(`/api/ic/packets/${packetId}/records`, [packetId]);

  const data = dil.data;
  const answers = new Map((data?.answers ?? []).map((a) => [a.section_id, a]));
  const isChampion = Boolean(data?.packet.champion_user_id && data.packet.champion_user_id === me.data?.id);
  const restricted = new Set(data?.restricted_section_ids ?? []);
  const readiness = data?.readiness;

  const lockReasonFor = (id: string) =>
    restricted.has(id) && isChampion
      ? "You are the deal champion, so you cannot write the bear case. Someone else has to argue against this investment — otherwise IC becomes a sales meeting for it."
      : undefined;

  return (
    <div className="page" data-testid="ic-portal-page">

      {readiness && (
        <p
          className={readiness.complete ? "notice" : "notice notice-warn"}
          data-testid="ic-readiness"
        >
          {readiness.complete
            ? "Diligence covered: every section is answered or explicitly not applicable."
            : `Still open: ${readiness.open.join(", ")}.`}
          {readiness.bear_case_missing && (
            <>
              {" "}
              <strong data-testid="ic-bear-case-warning">
                The bear case has not been written. Diligence is not finished.
              </strong>
            </>
          )}
        </p>
      )}

      <nav className="ic-tabs" data-testid="ic-tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={tab === t.key ? "ic-tab ic-tab-active" : "ic-tab"}
            aria-current={tab === t.key ? "page" : undefined}
            data-testid={`ic-tab-${t.key}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === "diligence" && data && (
        <div data-testid="ic-diligence">
          {data.framework.core.map((s) => (
            <SectionEditor
              key={s.id}
              packetId={packetId}
              sectionId={s.id}
              title={s.title}
              intent={s.intent}
              questions={s.questions}
              killer={s.killer}
              existing={answers.get(s.id)}
              locked={Boolean(lockReasonFor(s.id))}
              lockReason={lockReasonFor(s.id)}
              onSaved={dil.reload}
            />
          ))}

          {data.framework.sector && (
            <SectionEditor
              packetId={packetId}
              sectionId={`sector_${data.framework.sector.sector.toLowerCase()}`}
              title={`${data.framework.sector.title} (sector module)`}
              intent={data.framework.sector.intent}
              questions={data.framework.sector.questions}
              killer={data.framework.sector.killer}
              existing={answers.get(`sector_${data.framework.sector.sector.toLowerCase()}`)}
              locked={false}
              onSaved={dil.reload}
            />
          )}

          <h4>The Closing Six</h4>
          <p className="muted small">Mandatory for every West Peek investment, whatever the sector.</p>
          {data.framework.closing_six.map((q) => (
            <SectionEditor
              key={q.n}
              packetId={packetId}
              sectionId={`closing_${q.n}`}
              title={`${q.n}. ${q.question}`}
              existing={answers.get(`closing_${q.n}`)}
              locked={Boolean(lockReasonFor(`closing_${q.n}`))}
              lockReason={lockReasonFor(`closing_${q.n}`)}
              onSaved={dil.reload}
            />
          ))}
        </div>
      )}

      {tab === "followup" && (
        <section className="card" data-testid="ic-followup">
          <h4>Follow-Up</h4>
          {(follow.data?.followups ?? []).length === 0 ? (
            <p className="state-empty">Nothing yet. Follow-ups are what the decision obliges us to do.</p>
          ) : (
            <ul className="card-list small">
              {follow.data!.followups.map((f) => (
                <li key={f.id} data-testid={`ic-followup-${f.id}`}>
                  <span className="help-tag help-tag-muted">{f.assignee_kind.toLowerCase().replace(/_/g, " ")}</span>{" "}
                  {f.item_text}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {tab === "audit" && (
        <section className="card" data-testid="ic-audit">
          <h4>Audit</h4>
          <p className="muted small">
            Every event recorded against this packet, oldest first. Read from the append-only log —
            nothing here was curated.
          </p>
          {(audit.data?.events ?? []).length === 0 ? (
            <p className="state-empty">No events yet.</p>
          ) : (
            <ul className="card-list small" data-testid="ic-audit-list">
              {audit.data!.events.map((e, i) => (
                <li key={i}>
                  <code>{e.event_type}</code> · {actorName(e.actor_id)} ·{" "}
                  <span className="muted small">{new Date(e.created_at).toLocaleString()}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {tab === "company" && (
        <section className="card" data-testid="ic-tab-panel-company">
          <h4>Company</h4>
          <p className="muted small">
            {String(records.data?.packet?.canonical_name ?? "—")}
            {records.data?.packet?.description ? ` — ${String(records.data.packet.description)}` : ""}
          </p>
          <h4>Latest metrics</h4>
          {(records.data?.company.metrics ?? []).length === 0 ? (
            <p className="state-empty">No metrics recorded for this company.</p>
          ) : (
            <ul className="card-list small" data-testid="ic-company-metrics">
              {records.data!.company.metrics.map((m, i) => (
                <li key={i}>
                  {/* The stored key is `arr` / `burn_multiple`; a partner reading a committee packet
                      should not be shown a column name. Underscores out, sentence case in. */}
                  <strong>{String(m.metric_key).split("_").join(" ")}</strong> {String(m.value)}{" "}
                  {/* The as-of date travels with every figure: a number without one invites
                      someone to quote it in the room without knowing its age. */}
                  <span className="muted small">as of {String(m.as_of_date)} · {String(m.source ?? "—")}</span>
                </li>
              ))}
            </ul>
          )}
          <h4>Deal math</h4>
          {records.data?.company.deal_math ? (
            <p className="muted small" data-testid="ic-deal-math">
              valuation {String(records.data.company.deal_math.valuation ?? "—")} · check{" "}
              {String(records.data.company.deal_math.check_size ?? "—")} · ownership at close{" "}
              {String(records.data.company.deal_math.ownership_at_close ?? "—")} · expected exit ownership{" "}
              {String(records.data.company.deal_math.expected_exit_ownership ?? "—")}
            </p>
          ) : (
            <p className="state-empty">No deal math packet assembled yet.</p>
          )}
        </section>
      )}

      {tab === "memo" && (
        <section className="card" data-testid="ic-tab-panel-memo">
          <h4>Memo</h4>
          <p className="muted small">The claims this case rests on, with how many sources each has.</p>
          {records.data && records.data.memo.unsourced > 0 && (
            <p className="notice" data-testid="ic-memo-unsourced">
              {records.data.memo.unsourced} claim{records.data.memo.unsourced === 1 ? "" : "s"} with
              no source. An unsourced claim is an assertion, not evidence.
            </p>
          )}
          {(records.data?.memo.claims ?? []).length === 0 ? (
            <p className="state-empty">No claims recorded for this company.</p>
          ) : (
            <ul className="card-list small" data-testid="ic-memo-claims">
              {records.data!.memo.claims.map((c) => (
                <li key={String(c.id)}>
                  <span className={Number(c.source_count) === 0 ? "help-tag help-tag-warn" : "help-tag help-tag-good"}>
                    {Number(c.source_count) === 0 ? "unsourced" : `${c.source_count} source${Number(c.source_count) === 1 ? "" : "s"}`}
                  </span>{" "}
                  {String(c.claim_text)}{" "}
                  <span className="muted small">{String(c.claim_status).toLowerCase()}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {tab === "market" && (
        <section className="card" data-testid="ic-tab-panel-market">
          <h4>Market</h4>
          {records.data?.market ? (
            <>
              <p>
                <strong>{String(records.data.market.sector)}</strong>{" "}
                <span className="muted small">{String(records.data.market.company_count)} companies mapped</span>
              </p>
              <p className="muted small">{String(records.data.market.coverage_note ?? "")}</p>
            </>
          ) : (
            <p className="state-empty" data-testid="ic-no-market">
              No market map covers this sector yet. Build one in Market mapping and it appears here.
            </p>
          )}
        </section>
      )}

      {tab === "people" && (
        <section className="card" data-testid="ic-tab-panel-people">
          <h4>People</h4>
          {(records.data?.people ?? []).length === 0 ? (
            <p className="state-empty">No people linked to this company yet.</p>
          ) : (
            <ul className="card-list small" data-testid="ic-people">
              {records.data!.people.map((p) => (
                <li key={String(p.id)}>
                  <strong>{String(p.full_name)}</strong>{" "}
                  <span className="muted small">
                    {String(p.relationship_type ?? "")}
                    {p.email ? ` · ${String(p.email)}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {tab === "decision" && (
        <section className="card" data-testid="ic-tab-panel-decision">
          <h4>Decision</h4>
          {(records.data?.decisions ?? []).length === 0 ? (
            <p className="state-empty" data-testid="ic-no-decision">
              No decision recorded. It is made from the IC packet, against an approval receipt.
            </p>
          ) : (
            <ul className="card-list small" data-testid="ic-decisions">
              {records.data!.decisions.map((d) => (
                <li key={String(d.id)}>
                  <strong>{String(d.decision)}</strong>{" "}
                  <span className="muted small">
                    {String(d.decided_by)} · {new Date(String(d.created_at)).toLocaleString()}
                  </span>
                  {d.rationale ? <div>{String(d.rationale)}</div> : null}
                </li>
              ))}
            </ul>
          )}
          <p className="muted small">
            Append-only. A decision cannot be edited after the fact — a later view is recorded as a
            new decision, so the history of what was thought when survives.
          </p>
        </section>
      )}

      {tab === "live" && (
        <section className="card" data-testid="ic-tab-panel-live">
          <h4>Live Help</h4>
          {/* Deliberately a pointer, not a second chat. Live Help belongs to the meeting workspace
              where seating, the ≤5 cap and Revoke All already govern it; duplicating it here would
              mean two places to revoke access from. */}
          <p className="muted">
            Live Help runs in the meeting workspace. Seat an employee on the meeting and confer
            during the session — seating, the active-employee cap and Revoke All are governed there.
          </p>
        </section>
      )}

      <HowThisWorks
        title="IC Decision Portal"
        testId="ic-portal"
        what="The place an investment decision gets made and recorded — the diligence it rests on, the decision itself, what the decision obliges, and a permanent audit trail."
        when="From the moment a deal is being seriously considered through to the decision and its follow-ups."
        operatorDoes={[
          "Work through the eleven core sections and the sector module.",
          "Answer the Closing Six.",
          "Have someone other than the deal champion write the bear case.",
        ]}
        aiDoes={["Nothing writes diligence answers for you yet. Live Help can be conferred with during the meeting itself."]}
        requiresOperator={[
          "Every diligence answer.",
          "The decision, which is human-reserved and append-only once recorded.",
          "The bear case, which the deal champion is barred from writing.",
        ]}
        next="Readiness names what is still open. It never blocks a decision — the partners may decide against an incomplete packet, but the gap is on the record permanently."
        blocked={[
          "The deal champion cannot answer the kill case or Closing Six #6.",
          "A section marked not applicable needs a reason.",
          "Saving diligence needs the ic_packet.assemble action in your role.",
        ]}
      />
    </div>
  );
}
