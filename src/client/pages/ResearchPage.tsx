import { useState } from "react";
import { api, useApi, type MeResponse } from "../lib/api";
import { MarketMapPage } from "./MarketMapPage";
import { DeliverableList } from "./DeliverableList";
import { personaFor } from "@shared/registry/aiEmployeePersonas";
import { portraitAlt, portraitFor } from "../lib/employeePortraits";

/**
 * Research has an analyst, and it is Wyatt — not a new seat.
 *
 * The instinct was to invent a Head of Research. Wyatt is already Analyst & Scout, already owns the
 * research_intelligence machine, and is already the name on the intelligence you get each morning.
 * A second research seat beside him would be the split the roster consolidation removed: research
 * and sourcing read the same market, which is why they are one job here.
 *
 * WHY A WELCOME AT ALL. This page opened with a bare rule string and a form. Research is the one
 * surface where the answer genuinely does not arrive while you wait — a project is opened, sources
 * are gathered, findings are promoted — and a page that says nothing about that reads as broken
 * rather than as patient. Somebody telling you they will come back with it is the difference.
 */
const ANALYST = { name: "Wyatt", role: "Analyst & Scout" } as const;

/**
 * Research / Analyst Workstation (P21, GAP-14).
 *
 * Questions, sources with stated reliability, findings, promotion into governed evidence, and an
 * IC packet whose readiness is computed rather than asserted. Unresolved contradictions from the
 * firm's own evidence record travel with the work — they are shown, never filtered.
 */

interface Project {
  id: string;
  title: string;
  question: string;
  company_id: string | null;
  status: string;
  created_at: string;
}

interface Question {
  id: string;
  question: string;
  status: string;
  answer: string | null;
}

interface Source {
  id: string;
  kind: string;
  title: string;
  url: string | null;
  reliability: string;
  reliability_basis: string;
}

interface Finding {
  id: string;
  statement: string;
  confidence: number;
  source_title: string;
  reliability: string;
  promoted_claim_id: string | null;
  claim_status: string | null;
}

interface Packet {
  id: string;
  title: string;
  ic_ready: number;
  ic_readiness_note: string;
  created_at: string;
}

function ProjectDetail({ id, onChanged }: { id: string; onChanged: () => void }) {
  const detail = useApi<{
    project: Project;
    questions: Question[];
    sources: Source[];
    findings: Finding[];
    packets: Packet[];
    open_contradictions: Array<{ id: string; topic: string; materiality: string; status: string }>;
  }>(`/api/research/projects/${id}`);
  const [message, setMessage] = useState<string | null>(null);
  const [sourceTitle, setSourceTitle] = useState("");
  const [sourceKind, setSourceKind] = useState("HUMAN");
  const [reliability, setReliability] = useState("UNKNOWN");
  const [basis, setBasis] = useState("");
  const [statement, setStatement] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [packetTitle, setPacketTitle] = useState("");

  if (detail.loading && !detail.data) return <p>Loading project…</p>;
  if (!detail.data) return <p className="muted">Could not load this project.</p>;
  const d = detail.data;
  const refresh = () => {
    detail.reload();
    onChanged();
  };

  return (
    <section className="card" data-testid={`research-detail-${id}`}>
      <h3>
        {d.project.title} <span className="badge">{d.project.status}</span>
      </h3>
      <p className="muted small">{d.project.question}</p>

      <h4>Questions</h4>
      <ul className="card-list small" data-testid="research-questions">
        {d.questions.map((q) => (
          <li key={q.id}>
            <code>{q.status}</code> {q.question}
            {q.answer ? ` — ${q.answer}` : ""}
            {q.status === "OPEN" && (
              <>
                {" "}
                <button
                  type="button"
                  className="link-button"
                  data-testid={`research-answer-${q.id}`}
                  onClick={async () => {
                    const answer = window.prompt("What is the answer?");
                    if (!answer) return;
                    await api(`/api/research/questions/${q.id}/answer`, { method: "POST", body: { status: "ANSWERED", answer } });
                    refresh();
                  }}
                >
                  Answer
                </button>
              </>
            )}
          </li>
        ))}
      </ul>

      <h4>Sources</h4>
      <form
        className="form-row"
        data-testid="research-source-form"
        onSubmit={async (e) => {
          e.preventDefault();
          const res = await api<{ error?: string; detail?: string }>(`/api/research/projects/${id}/sources`, {
            method: "POST",
            body: { kind: sourceKind, title: sourceTitle, reliability, reliability_basis: basis },
          });
          setMessage(res.status === 201 ? "Source recorded." : `Refused: ${res.data?.detail ?? res.data?.error ?? res.status}`);
          setSourceTitle("");
          setBasis("");
          refresh();
        }}
      >
        <select data-testid="research-source-kind" value={sourceKind} onChange={(e) => setSourceKind(e.target.value)}>
          {["HUMAN", "URL", "DOCUMENT", "INTELLIGENCE_ITEM", "INTERNAL_RECORD"].map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <input data-testid="research-source-title" value={sourceTitle} onChange={(e) => setSourceTitle(e.target.value)} placeholder="What is the source?" />
        <select data-testid="research-source-reliability" value={reliability} onChange={(e) => setReliability(e.target.value)}>
          {["UNKNOWN", "LOW", "MEDIUM", "HIGH"].map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <input data-testid="research-source-basis" value={basis} onChange={(e) => setBasis(e.target.value)} placeholder="What does that judgement rest on?" />
        <button type="submit" className="btn-strong" data-testid="research-source-submit">
          Add source
        </button>
      </form>
      <ul className="card-list small" data-testid="research-sources">
        {d.sources.map((s) => (
          <li key={s.id}>
            <code>{s.kind}</code> {s.title} — reliability {s.reliability}
            {s.reliability_basis ? ` (${s.reliability_basis})` : ""}
          </li>
        ))}
        {d.sources.length === 0 && <li className="state-empty">No sources recorded yet.</li>}
      </ul>

      <h4>Findings</h4>
      <form
        className="form-row"
        data-testid="research-finding-form"
        onSubmit={async (e) => {
          e.preventDefault();
          const res = await api<{ note?: string; error?: string; detail?: string }>(`/api/research/projects/${id}/findings`, {
            method: "POST",
            body: { source_id: sourceId || d.sources[0]?.id, statement },
          });
          setMessage(res.status === 201 ? res.data?.note ?? "Finding recorded." : `Refused: ${res.data?.detail ?? res.data?.error ?? res.status}`);
          setStatement("");
          refresh();
        }}
      >
        <select data-testid="research-finding-source" value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
          <option value="">(first source)</option>
          {d.sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
        </select>
        <input
          className="field-wide" data-testid="research-finding-statement"
          value={statement}
          onChange={(e) => setStatement(e.target.value)}
          placeholder="What did you find?"
        />
        <button type="submit" className="btn-strong" data-testid="research-finding-submit">
          Record finding
        </button>
      </form>
      <ul className="card-list small" data-testid="research-findings">
        {d.findings.map((f) => (
          <li key={f.id} data-testid={`research-finding-${f.id}`}>
            {f.statement} — <span className="muted">{f.source_title} ({f.reliability})</span>{" "}
            {f.promoted_claim_id ? (
              <span className="badge badge-ok">governed claim · {f.claim_status}</span>
            ) : (
              <>
                <span className="badge badge-gate">research only — not evidence</span>{" "}
                <button
                  type="button"
                  className="link-button"
                  data-testid={`research-promote-${f.id}`}
                  onClick={async () => {
                    const res = await api<{ note?: string; error?: string; detail?: string }>(`/api/research/findings/${f.id}/promote`, {
                      method: "POST",
                      body: {},
                    });
                    setMessage(res.status === 201 ? res.data?.note ?? "Promoted." : `Refused: ${res.data?.detail ?? res.data?.error ?? res.status}`);
                    refresh();
                  }}
                >
                  Promote into evidence
                </button>
              </>
            )}
          </li>
        ))}
        {d.findings.length === 0 && <li className="state-empty">No findings yet.</li>}
      </ul>

      {d.open_contradictions.length > 0 && (
        <section className="card" data-testid="research-contradictions">
          <h4>Unresolved contradictions on this company</h4>
          <p className="muted small">From the firm&apos;s own evidence record. These travel with the packet and are never filtered out.</p>
          <ul className="small">
            {d.open_contradictions.map((c) => (
              <li key={c.id}>
                <code>{c.materiality}</code> {c.topic} — {c.status}
              </li>
            ))}
          </ul>
        </section>
      )}

      <h4>Packets</h4>
      <form
        className="form-row"
        data-testid="research-packet-form"
        onSubmit={async (e) => {
          e.preventDefault();
          const res = await api<{ ic_readiness_note?: string }>(`/api/research/projects/${id}/packets`, {
            method: "POST",
            body: { title: packetTitle || `${d.project.title} packet` },
          });
          setMessage(res.data?.ic_readiness_note ?? `Assembly failed (HTTP ${res.status}).`);
          setPacketTitle("");
          refresh();
        }}
      >
        <input data-testid="research-packet-title" value={packetTitle} onChange={(e) => setPacketTitle(e.target.value)} placeholder="Packet title" />
        <button type="submit" className="btn-strong" data-testid="research-packet-submit">
          Assemble packet
        </button>
      </form>
      <ul className="card-list small" data-testid="research-packets">
        {d.packets.map((p) => (
          <li key={p.id}>
            {p.title} {p.ic_ready ? <span className="badge badge-ok">IC-ready</span> : <span className="badge badge-gate">not IC-ready</span>} —{" "}
            {p.ic_readiness_note}
          </li>
        ))}
        {d.packets.length === 0 && <li className="state-empty">No packets assembled. IC-readiness is computed: every question closed, every finding promoted.</li>}
      </ul>

      {message && <p className="notice" data-testid="research-message">{message}</p>}
    </section>
  );
}

export function ResearchPage({ me, onNavigate }: { me: MeResponse; onNavigate: (k: string) => void }) {
  const projects = useApi<{ projects: Project[]; rule: string }>("/api/research/projects");
  const [title, setTitle] = useState("");
  const [question, setQuestion] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  return (
    <section data-testid="research-page">
      <div className="card professor-welcome" data-testid="research-analyst">
        {portraitFor(ANALYST.name) ? (
          <img className="professor-face" src={portraitFor(ANALYST.name)!} alt={portraitAlt(ANALYST.name, ANALYST.role)} />
        ) : (
          <span className="professor-face professor-face-initial" aria-hidden="true">{ANALYST.name.slice(0, 1)}</span>
        )}
        <div>
          <p>
            <strong>{ANALYST.name}</strong> <span className="muted small">{ANALYST.role}</span>
          </p>
          <p className="small">
            Research runs through me. Open a project with the question you actually want answered and
            I will gather the sources, say how reliable each one is, and come back with findings —
            this is not a search box, and the answer arrives after the work rather than instead of it.
          </p>
          <p className="muted small">{personaFor(ANALYST.name)?.voice ?? ""}</p>
        </div>
      </div>

      {/*
        WHAT WYATT HAS ALREADY DELIVERED.

        A finished project produces a packet, and until now that packet went nowhere — the record
        existed and nothing put it in front of the person who asked. The latest five sit here as a
        convenience view; every one of them is also filed in Documents from the moment it is
        delivered, so nothing migrates between the two and "where is it now" has one answer.
      */}
      <section data-testid="research-delivered">
        <div className="home-section-head">
          <h3>Delivered research</h3>
          <span className="muted small">the five most recent · all of them live in Documents</span>
        </div>
        <DeliverableList
          kind="research_packet"
          limit={5}
          onNavigate={onNavigate}
          emptyNote="Nothing delivered yet. Open a project below, gather sources, then assemble a packet — that is the point at which Wyatt hands it over, files it, and puts it on your Home page."
        />
      </section>

      <p className="muted small" data-testid="research-rule">
        {projects.data?.rule}
      </p>

      <form
        className="card"
        data-testid="research-project-form"
        onSubmit={async (e) => {
          e.preventDefault();
          const res = await api<{ id?: string; error?: string }>("/api/research/projects", {
            method: "POST",
            body: { title, question },
          });
          if (res.status === 201 && res.data?.id) {
            setSelected(res.data.id);
            setMessage(`Opened “${title}” for ${me.fullName}.`);
            setTitle("");
            setQuestion("");
            projects.reload();
          } else {
            setMessage(`Refused: ${res.data?.error ?? res.status}`);
          }
        }}
      >
        <div className="form-row">
          <input data-testid="research-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Project title" />
          <input
            className="field-wide" data-testid="research-question"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="The question this research must answer"
          />
          <button type="submit" className="btn-strong" data-testid="research-submit">
            Launch research
          </button>
        </div>
      </form>
      {message && <p className="notice" data-testid="research-page-message">{message}</p>}

      {selected && <ProjectDetail id={selected} onChanged={projects.reload} />}

      <h3>Projects</h3>
      <ul className="card-list small" data-testid="research-projects">
        {(projects.data?.projects ?? []).map((p) => (
          <li key={p.id}>
            <span className="badge">{p.status}</span>{" "}
            <button type="button" className="link-button" data-testid={`research-open-${p.id}`} onClick={() => setSelected(p.id)}>
              {p.title}
            </button>{" "}
            <span className="muted">{p.question}</span>
          </li>
        ))}
        {!projects.loading && (projects.data?.projects ?? []).length === 0 && <li className="state-empty">No research projects yet. Launch one with the question it exists to answer; findings promote into the evidence substrate, never a second store.</li>}
      </ul>
      {/* MARKET MAPPING FOLDED IN. It had its own tab and almost nothing on it, which made it
          look like a feature that had been abandoned rather than one you had not used yet. It is
          the same activity as everything else here — finding out what is true about a market —
          so it belongs beside the rest of it rather than one click away in a tab of its own. */}
      <details className="card summary-button" data-testid="research-market-map">
        <summary>Map a market</summary>
        <p className="muted small">
          A market map is the picture of who is already doing the thing a founder just pitched you:
          the incumbents, the challengers, who is funded and by whom, and where the gap is that
          makes a new company plausible. Build one before an IC conversation and the question stops
          being <em>is this good</em> and becomes <em>is this better than the six companies already
          doing it</em>.
        </p>
        <p className="muted small">
          Research answers a question. A map answers <em>who else is here</em> — which is why they
          live on the same page.
        </p>
        <MarketMapPage />
      </details>
    </section>
  );
}
