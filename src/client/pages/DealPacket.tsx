import { useState } from "react";
import { api, useApi, type MeResponse } from "../lib/api";
import { actorName } from "@shared/help/actionNames";
import { FacePanel, Faces, type Face } from "./Faces";

/**
 * THE PACKET, as faces of the deal record (design/DEALS_SECTION_DESIGN.md §4, owner's answer to
 * approval question 4 on 18 Sep 2026).
 *
 * This is `IcPortalPage.tsx` (P34) with its nine tabs reduced to the five that carry something the
 * record does not already hold: Diligence · Memo · Market · People · Audit. Company was the record's
 * own "The deal itself" and "What we know" faces; Decision is the committee face, where the
 * decision is actually made; Live Help is the room, on Meetings, and a pointer to it here was the
 * second copy of an instruction. The portal was dead-mounted — reachable only from `InvestmentPage`,
 * which nothing routed to — so nobody had read these tabs since the Investment page was superseded.
 * They are reachable now from "Open the packet" on the committee face.
 *
 * Two things this keeps refusing to do, both deliberate and both P34's:
 *
 *   NO COMPLETION PERCENTAGE. Readiness names the open sections. A number lets a packet read "92%"
 *   with the kill case empty, which is the failure the framework exists to prevent.
 *
 *   NO SILENT CHAMPION BEAR CASE. The bear-case fields are disabled for the named champion, with
 *   the reason shown. The server refuses it too — this is the courtesy, not the control.
 *
 * Every face says what it holds on its tab, and a face with nothing in it says so in words — never a
 * blank panel.
 */

type PacketFace = "diligence" | "memo" | "market" | "people" | "audit";

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

/** What an audit event on the packet MEANS. The key is never printed at a partner. */
const AUDIT_WORDS: Record<string, string> = {
  "ic.packet_assembled": "The packet was assembled",
  "ic.packet_submitted": "The packet was put in front of the partners",
  "ic.decision_recorded": "A decision was recorded",
  "ic.dissent_recorded": "A partner recorded that they disagreed",
  "ic.question_raised": "A gap was named as a question",
  "ic.question_resolved": "A question was answered or withdrawn",
  "ic.diligence_answered": "A diligence section was answered",
  "ic.followup_added": "A follow-up the decision obliges was added",
};

function auditSentence(key: string): string {
  const known = AUDIT_WORDS[key];
  if (known) return known;
  const tail = key.includes(".") ? key.slice(key.indexOf(".") + 1) : key;
  const words = tail.split(/[._]+/).join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function when(iso: string): string {
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? new Date(t).toLocaleString() : "no time recorded";
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
    if (res.status !== 201) setErr(res.data?.detail ?? res.data?.error ?? `Not saved (HTTP ${res.status}). Try again, or say why it does not apply.`);
    setBusy(false);
    onSaved();
  }

  return (
    <section className="card ic-section" data-testid={`ic-section-${sectionId}`}>
      <h4>
        {title}{" "}
        <span
          className={state === "ANSWERED" ? "badge badge-ok" : state === "NOT_APPLICABLE" ? "badge" : "badge badge-gate"}
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
        <p className="notice notice-gate" data-testid={`ic-locked-${sectionId}`}>{lockReason}</p>
      ) : (
        <>
          <label className="field">
            What we found, and what we still do not know
            <textarea
              data-testid={`ic-body-${sectionId}`}
              rows={5}
              value={body}
              aria-invalid={err ? true : undefined}
              onChange={(e) => setBody(e.target.value)}
            />
            <span className={err ? "field-help err" : "field-help"} data-testid={err ? `ic-error-${sectionId}` : undefined}>
              {err ?? "Saved answers appear in the packet's audit with your name against them."}
            </span>
          </label>
          <div className="form-row">
            <button type="button" className="btn-strong" disabled={busy} aria-busy={busy || undefined} data-testid={`ic-save-${sectionId}`} onClick={() => save("ANSWERED")}>
              {busy ? "Saving…" : "Save answer"}
            </button>
            <label>
              Not applicable because{" "}
              <input
                data-testid={`ic-na-${sectionId}`}
                value={naReason}
                onChange={(e) => setNaReason(e.target.value)}
              />
            </label>
            <button type="button" disabled={busy || !naReason.trim()} data-testid={`ic-na-save-${sectionId}`} onClick={() => save("NOT_APPLICABLE")}>
              Mark not applicable
            </button>
          </div>
        </>
      )}
    </section>
  );
}

export function DealPacket({ packetId, me }: { packetId: string; me: MeResponse }): JSX.Element {
  const [face, setFace] = useState<PacketFace>("diligence");
  const dil = useApi<DiligenceResponse>(`/api/ic/packets/${packetId}/diligence`, [packetId]);
  const audit = useApi<{ events: Array<{ event_type: string; actor_id: string; created_at: string }> }>(
    `/api/ic/packets/${packetId}/audit`, [packetId],
  );
  const follow = useApi<{ followups: Array<{ id: string; item_text: string; assignee_kind: string; state: string }> }>(
    `/api/ic/packets/${packetId}/followups`, [packetId],
  );
  // One request for the record-backed faces: they are views of one deal, and one round trip each
  // to render one screen is a slow screen.
  const records = useApi<Rec>(`/api/ic/packets/${packetId}/records`, [packetId]);

  const data = dil.data;
  const answers = new Map((data?.answers ?? []).map((a) => [a.section_id, a]));
  const isChampion = Boolean(data?.packet.champion_user_id && data.packet.champion_user_id === me.id);
  const restricted = new Set(data?.restricted_section_ids ?? []);
  const readiness = data?.readiness;

  const lockReasonFor = (id: string) =>
    restricted.has(id) && isChampion
      ? "You are the deal champion, so you cannot write the bear case. Someone else has to argue against this investment — otherwise the committee becomes a sales meeting for it."
      : undefined;

  const claims = records.data?.memo.claims ?? [];
  const people = records.data?.people ?? [];
  const events = audit.data?.events ?? [];
  const followups = follow.data?.followups ?? [];

  const faces: Face[] = [
    {
      key: "diligence",
      label: "Diligence",
      badge: readiness
        ? readiness.complete
          ? { text: "covered", tone: "ok" }
          : { text: `${readiness.open.length} open`, tone: "gate" }
        : { text: dil.loading ? "loading" : "not read" },
    },
    { key: "memo", label: "Memo", badge: records.data ? (claims.length === 0 ? { text: "empty" } : { text: `${claims.length} claim${claims.length === 1 ? "" : "s"}` }) : { text: "loading" } },
    { key: "market", label: "Market", badge: records.data ? (records.data.market ? { text: "mapped", tone: "ok" } : { text: "empty" }) : { text: "loading" } },
    { key: "people", label: "People", badge: records.data ? (people.length === 0 ? { text: "empty" } : { text: String(people.length) }) : { text: "loading" } },
    { key: "audit", label: "Audit", badge: audit.data ? { text: `${events.length} event${events.length === 1 ? "" : "s"}` } : { text: "loading" } },
  ];

  return (
    <div className="stack" data-testid="deal-packet">
      {readiness && (
        <p className={readiness.complete ? "notice" : "notice notice-gate"} data-testid="ic-readiness">
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

      <Faces label="The packet" faces={faces} active={face} onPick={(k) => setFace(k as PacketFace)} idPrefix="packet" testId="packet-face" />

      <FacePanel idPrefix="packet" face="diligence" active={face} testId="ic-diligence">
        {data ? (
          <div className="stack">
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
        ) : (
          <p className="state-empty">
            {dil.loading
              ? "Reading the framework…"
              : `The diligence framework could not be read${dil.status ? ` (HTTP ${dil.status})` : ""}. The packet exists; its sections do not load until it can be.`}
          </p>
        )}
      </FacePanel>

      <FacePanel idPrefix="packet" face="memo" active={face} testId="ic-tab-panel-memo">
        <section className="card">
          <h4>Memo</h4>
          <p className="muted small">The claims this case rests on, with how many sources each has.</p>
          {records.data && records.data.memo.unsourced > 0 && (
            <p className="notice notice-gate" data-testid="ic-memo-unsourced">
              {records.data.memo.unsourced} claim{records.data.memo.unsourced === 1 ? "" : "s"} with
              no source. An unsourced claim is an assertion, not evidence.
            </p>
          )}
          {claims.length === 0 ? (
            <p className="state-empty">
              {records.loading
                ? "Reading the record…"
                : "No claim is on record for this company, so the memo has nothing to rest on. Claims arrive from a meeting, a document, or an employee reading the deck."}
            </p>
          ) : (
            <ul className="card-list small" data-testid="ic-memo-claims">
              {claims.map((c) => (
                <li key={String(c.id)}>
                  <span className={Number(c.source_count) === 0 ? "badge badge-gate" : "badge badge-ok"}>
                    {Number(c.source_count) === 0 ? "unsourced" : `${c.source_count} source${Number(c.source_count) === 1 ? "" : "s"}`}
                  </span>{" "}
                  {String(c.claim_text)}{" "}
                  <span className="muted small">{String(c.claim_status).toLowerCase().split("_").join(" ")}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </FacePanel>

      <FacePanel idPrefix="packet" face="market" active={face} testId="ic-tab-panel-market">
        <section className="card">
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
              {records.loading
                ? "Reading the record…"
                : "No market map covers this sector yet. Build one under Research and it appears here."}
            </p>
          )}
        </section>
      </FacePanel>

      <FacePanel idPrefix="packet" face="people" active={face} testId="ic-tab-panel-people">
        <section className="card">
          <h4>People</h4>
          {people.length === 0 ? (
            <p className="state-empty">
              {records.loading
                ? "Reading the record…"
                : "No person is linked to this company yet. Founders and contacts are linked on Network, and appear here the moment they are."}
            </p>
          ) : (
            <ul className="card-list small" data-testid="ic-people">
              {people.map((p) => (
                <li key={String(p.id)}>
                  <strong>{String(p.full_name)}</strong>{" "}
                  <span className="muted small">
                    {String(p.relationship_type ?? "").toLowerCase().split("_").join(" ")}
                    {p.email ? ` · ${String(p.email)}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </FacePanel>

      <FacePanel idPrefix="packet" face="audit" active={face} testId="ic-audit">
        <section className="card">
          <h4>Audit</h4>
          <p className="muted small">
            Every event recorded against this packet, oldest first. Read from the append-only log —
            nothing here was curated.
          </p>
          {events.length === 0 ? (
            <p className="state-empty">
              {audit.loading ? "Reading the log…" : "Nothing has been recorded against this packet yet. Assembling it is the first event, and it has not happened."}
            </p>
          ) : (
            <ul className="card-list small" data-testid="ic-audit-list">
              {events.map((e, i) => (
                <li key={i}>
                  <strong>{auditSentence(e.event_type)}</strong> · {actorName(e.actor_id)} ·{" "}
                  <span className="muted small">{when(e.created_at)}</span>
                </li>
              ))}
            </ul>
          )}

          <h4>What the decision obliges</h4>
          {followups.length === 0 ? (
            <p className="state-empty" data-testid="ic-followup">
              {follow.loading ? "Reading the follow-ups…" : "Nothing yet. Follow-ups are what the decision obliges the firm to do, and no decision has obliged anything."}
            </p>
          ) : (
            <ul className="card-list small" data-testid="ic-followup">
              {followups.map((f) => (
                <li key={f.id} data-testid={`ic-followup-${f.id}`}>
                  <span className="badge">{f.assignee_kind.toLowerCase().split("_").join(" ")}</span>{" "}
                  {f.item_text}
                </li>
              ))}
            </ul>
          )}
        </section>
      </FacePanel>
    </div>
  );
}
