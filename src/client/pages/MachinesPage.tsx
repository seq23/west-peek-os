import { useEffect, useRef, useState } from "react";
import { departmentDef } from "@shared/registry/departments";
import { skillsForMachines } from "@shared/skills/library";
import { api, useApi, type MeResponse } from "../lib/api";

/**
 * Machine Control Center + Capability Intelligence (P17; GAP-06, GAP-07).
 *
 * The 45-machine registry as an operable fleet, and the firm's internal capability
 * registry beside it. Pause is a real control: the server refuses work routing and AI
 * spend for a paused machine, and this page says so rather than implying it.
 */

interface MachineRow {
  id: number;
  key: string;
  name: string;
  domain_id: string;
  purpose: string;
  status: string;
  priority: string;
  sla_target: string;
  owner_firm_user_id: string | null;
  evidence_expectation: string;
  pause_reason: string | null;
  allowed_tools_json: string;
  data_access_json: string;
  employees: Array<{ id: string; name: string; status: string }>;
  queue: Array<{ id: string; title: string; state: string; priority: string }>;
  runs_30d: number;
  failures_30d: number;
  spend_30d_usd: number;
  recent_failures: Array<{ id: string; reason: string; at: string }>;
  depends_on: Array<{ machine_id: number; kind: string }>;
  capabilities: Array<{ capability_key: string; name: string; state: string; tested_state: string }>;
  model_policy: { preferred_provider_key: string | null; preferred_model: string | null } | null;
}

interface CapabilityRow {
  id: string;
  capability_key: string;
  name: string;
  description: string;
  maturity: string;
  confidence: string;
  state: string;
  tested_state: string;
  model_dependencies_json: string;
  tool_dependencies_json: string;
  cost_estimate_usd: number | null;
  cost_basis: string;
  after_action_count: number;
  success_rate: number | null;
  observed_cost_usd: number | null;
  assignments: Array<{ kind: string; id: string }>;
  build_vs_buy: { decision: string; vendor: string | null; rationale: string } | null;
}

function statusBadge(status: string): string {
  return status === "PAUSED" ? "badge badge-gate" : "badge badge-ok";
}

function testedBadge(state: string): string {
  if (state === "PROVEN_LIVE") return "badge badge-ok";
  if (state === "PROVEN_LOCAL" || state === "FIXTURE_TESTED") return "badge badge-gate";
  return "badge badge-bad";
}

function MachineDetail({ machine, onChanged }: { machine: MachineRow; onChanged: () => void }) {
  const [message, setMessage] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [memo, setMemo] = useState("");
  const detail = useApi<{ memory: Array<{ id: string; kind: string; body: string; created_at: string }>; state_changes: Array<{ id: string; from_status: string; to_status: string; reason: string }>; dependencies: Array<{ id: string; depends_on_name: string; kind: string }> }>(
    `/api/machines/${machine.id}/state`,
  );

  return (
    <section className="card" data-testid={`machine-detail-${machine.id}`}>
      <h3>
        #{machine.id} {machine.name} <span className={statusBadge(machine.status)}>{machine.status}</span>
      </h3>
      <p className="muted small">{machine.purpose}</p>
      <p className="small">
        {machine.domain_id} · priority {machine.priority} · {machine.runs_30d} run(s)/30d ({machine.failures_30d} failed) · $
        {machine.spend_30d_usd.toFixed(4)}
        {machine.sla_target ? ` · SLA: ${machine.sla_target}` : ""}
      </p>
      {machine.pause_reason && <p className="muted small">Paused because: {machine.pause_reason}</p>}
      {machine.model_policy?.preferred_model && (
        <p className="muted small">
          model policy: {machine.model_policy.preferred_provider_key}/{machine.model_policy.preferred_model}
        </p>
      )}

      <h4>Assigned employees</h4>
      <p className="small">
        {machine.employees.length > 0 ? machine.employees.map((e) => `${e.name} (${e.status})`).join(", ") : "none assigned"}
      </p>

      <h4>Queue</h4>
      <ul className="card-list small" data-testid={`machine-queue-${machine.id}`}>
        {machine.queue.map((q) => (
          <li key={q.id}>
            {q.title} — <code>{q.state}</code>
          </li>
        ))}
        {machine.queue.length === 0 && <li className="state-empty">Nothing queued.</li>}
      </ul>

      {machine.recent_failures.length > 0 && (
        <>
          <h4>Recent failures</h4>
          <ul className="card-list small">
            {machine.recent_failures.map((f) => (
              <li key={f.id}>
                {f.reason} — {f.at}
              </li>
            ))}
          </ul>
        </>
      )}

      <h4>Controls</h4>
      <div className="form-row">
        <input
          aria-label="Why — recorded against this change" data-testid={`machine-reason-${machine.id}`}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason (required)"
        />
        <button
          type="button"
          data-testid={`machine-pause-${machine.id}`}
          onClick={async () => {
            const res = await api<{ error?: string; detail?: string }>(`/api/machines/${machine.id}/pause`, {
              method: "POST",
              body: { status: machine.status === "PAUSED" ? "ACTIVE" : "PAUSED", reason: reason || "operator action" },
            });
            setMessage(
              res.status === 200
                ? machine.status === "PAUSED"
                  ? "Resumed. Routing and AI spend are allowed again."
                  : "Paused. The server now refuses work routing and AI spend for this machine."
                : `Refused: ${res.data?.detail ?? res.data?.error ?? res.status}`,
            );
            onChanged();
            detail.reload();
          }}
        >
          {machine.status === "PAUSED" ? "Resume" : "Pause"}
        </button>
      </div>

      <div className="form-row">
        <input aria-label="Note to keep on this department" data-testid={`machine-memo-${machine.id}`} value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="Operating note" />
        <button
          type="button"
          data-testid={`machine-memo-submit-${machine.id}`}
          onClick={async () => {
            const res = await api(`/api/machines/${machine.id}/memory`, { method: "POST", body: { kind: "OPERATING_NOTE", body: memo } });
            setMessage(res.status === 201 ? "Note appended to machine memory." : `Refused (HTTP ${res.status}).`);
            setMemo("");
            detail.reload();
          }}
        >
          Append memory
        </button>
      </div>
      {message && <p data-testid={`machine-message-${machine.id}`}>{message}</p>}

      <h4>Memory</h4>
      <ul className="card-list small" data-testid={`machine-memory-${machine.id}`}>
        {(detail.data?.memory ?? []).map((m) => (
          <li key={m.id}>
            <code>{m.kind}</code> {m.body} — {m.created_at}
          </li>
        ))}
        {(detail.data?.memory ?? []).length === 0 && <li className="state-empty">No memory recorded.</li>}
      </ul>
    </section>
  );
}

function CapabilityPanel({ me }: { me: MeResponse }) {
  const caps = useApi<{
    capabilities: CapabilityRow[];
    active: CapabilityRow[];
    bench: CapabilityRow[];
    archive: CapabilityRow[];
    recommended_stack: Array<{ capability_key: string; name: string; success_rate: number; sample_size: number; why: string }>;
    definitions: Record<string, string>;
  }>("/api/capabilities");
  const [message, setMessage] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const [name, setName] = useState("");

  const section = (title: string, rows: CapabilityRow[], testid: string) => (
    <section className="module-card" data-testid={testid}>
      <h4>
        {title} <span className="module-count">{rows.length}</span>
      </h4>
      <ul className="card-list small">
        {rows.map((c) => (
          <li key={c.id}>
            <strong>{c.name}</strong> <span className="badge">{c.maturity}</span>{" "}
            <span className={testedBadge(c.tested_state)}>{c.tested_state}</span>
            <br />
            <span className="muted">
              confidence {c.confidence} ·{" "}
              {c.success_rate === null ? "no recorded outcomes" : `${c.success_rate}% success over ${c.after_action_count} use(s)`}
              {c.cost_estimate_usd !== null ? ` · est. $${c.cost_estimate_usd} (${c.cost_basis})` : ""}
              {c.assignments.length > 0 ? ` · assigned to ${c.assignments.map((a) => `${a.kind}:${a.id}`).join(", ")}` : ""}
              {c.build_vs_buy ? ` · ${c.build_vs_buy.decision}${c.build_vs_buy.vendor ? ` (${c.build_vs_buy.vendor})` : ""}` : ""}
            </span>
          </li>
        ))}
        {rows.length === 0 && <li className="state-empty">None.</li>}
      </ul>
    </section>
  );

  return (
    <section data-testid="capabilities-panel">
      <h3>Capabilities</h3>
      <div className="module-grid">
        {section("Active", caps.data?.active ?? [], "capabilities-active")}
        {section("Bench", caps.data?.bench ?? [], "capabilities-bench")}
        {section("Archive", caps.data?.archive ?? [], "capabilities-archive")}
      </div>

      <section className="card" data-testid="recommended-stack">
        <h4>Recommended stack</h4>
        <p className="muted small">{caps.data?.definitions.recommended_stack}</p>
        <ul className="card-list small">
          {(caps.data?.recommended_stack ?? []).map((r) => (
            <li key={r.capability_key}>
              {r.name} — {r.why}
            </li>
          ))}
          {(caps.data?.recommended_stack ?? []).length === 0 && (
            <li className="state-empty">Nothing recommended: no ACTIVE capability has a recorded outcome yet.</li>
          )}
        </ul>
      </section>

      <form
        className="form-row"
        data-testid="capability-form"
        onSubmit={async (e) => {
          e.preventDefault();
          const res = await api<{ error?: string; detail?: string }>("/api/capabilities", {
            method: "POST",
            body: { capability_key: key, name, tested_state: "UNTESTED" },
          });
          setMessage(
            res.status === 201
              ? `Registered “${name}” on the bench, UNTESTED. It cannot be made ACTIVE until something is proven.`
              : `Refused: ${res.data?.detail ?? res.data?.error ?? res.status}`,
          );
          setKey("");
          setName("");
          caps.reload();
        }}
      >
        <input data-testid="capability-key" aria-label="Capability key" value={key} onChange={(e) => setKey(e.target.value)} placeholder="capability_key" />
        <input data-testid="capability-name" aria-label="Capability name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" />
        <button type="submit" className="btn-strong" data-testid="capability-submit">
          Register capability
        </button>
      </form>
      {message && <p className="notice" data-testid="capability-message">{message}</p>}
      <p className="muted small">
        {caps.data?.definitions.maturity} {caps.data?.definitions.tested_state} (signed in as {me.fullName})
      </p>
    </section>
  );
}

export function MachinesPage({ me }: { me: MeResponse }) {
  const fleet = useApi<{ machines: MachineRow[]; note: string }>("/api/machines/control-center");
  const [selected, setSelected] = useState<number | null>(null);
  const detailRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (selected === null || !detailRef.current) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    detailRef.current.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  }, [selected]);
  const [domain, setDomain] = useState("ALL");

  if (fleet.loading && !fleet.data) return <p data-testid="machines-loading">Loading the fleet…</p>;
  if (!fleet.data) return <p data-testid="machines-error">Could not load the machine fleet (HTTP {fleet.status ?? "?"}).</p>;

  const domains = [...new Set(fleet.data.machines.map((m) => m.domain_id))].sort();
  const shown = domain === "ALL" ? fleet.data.machines : fleet.data.machines.filter((m) => m.domain_id === domain);
  const selectedMachine = selected === null ? null : fleet.data.machines.find((m) => m.id === selected) ?? null;

  return (
    <section data-testid="machines-page">
      {/*
        WHAT A MACHINE IS, said once, at the top.

        The page opened on a filter of shouted enum values and a table of ids, and the operator's
        verdict was that it "tells me nothing" — accurate, because nothing on it said what a machine
        was or why the firm has forty-five. A machine is a part of the firm that does a kind of
        work: a department. Saying so is most of the fix.
      */}
      <div className="card" data-testid="machines-what">
        <p className="small">
          <strong>A machine is a department</strong> — a part of the firm that does one kind of work.
          Employees are seated in them, work is routed to them, and each one has its own budget,
          its own pause switch and its own methods.
        </p>
        <p className="muted small" data-testid="machines-note">
          {fleet.data.machines.length} of them, grouped into {domains.length} areas ·{" "}
          {fleet.data.machines.filter((m) => m.status === "PAUSED").length} paused. {fleet.data.note}
        </p>
      </div>

      <div className="form-row">
        <label>
          Area{" "}
          <select data-testid="machines-domain" value={domain} onChange={(e) => setDomain(e.target.value)}>
            <option value="ALL">Everything ({fleet.data.machines.length})</option>
            {domains.map((d) => (
              <option key={d} value={d}>
                {departmentDef(d).name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* THE SKILL LIBRARY, where the department it belongs to is on screen.
          The firm's methods used to live scattered across prompt strings in four services, so
          "how we screen a deal" could not be read, reviewed or disagreed with. Now an employee
          seated here reads these before working, and so can you. */}
      {domain !== "ALL" && (
        <section className="card" data-testid="department-skills">
          <div className="home-section-head">
            <h3>{departmentDef(domain).name}</h3>
            <span className="muted small">{departmentDef(domain).what}</span>
          </div>
          {(() => {
            const keys = shown.map((m) => m.key);
            const skills = skillsForMachines(keys);
            if (skills.length === 0) {
              return (
                <p className="state-empty">
                  No methods written down for this area yet. Employees seated here work from their
                  own judgement and whatever the card says — which is how the whole firm worked
                  until recently, and why it was impossible to review.
                </p>
              );
            }
            return (
              <>
                <p className="muted small">
                  {skills.length} method{skills.length === 1 ? "" : "s"} every employee seated here
                  reads before working. Guidelines, not rules — the rules are enforced in code and
                  cannot be broken from a prompt.
                </p>
                <ul className="card-list small">
                  {skills.map((sk) => (
                    <li key={sk.key} data-testid={`skill-${sk.key}`}>
                      <details>
                        <summary>
                          <strong>{sk.title}</strong> <span className="muted small">{sk.when}</span>
                        </summary>
                        <ul className="card-list small">
                          {sk.guidance.map((g, i) => (
                            <li key={i}>{g.trim()}</li>
                          ))}
                        </ul>
                      </details>
                    </li>
                  ))}
                </ul>
              </>
            );
          })()}
        </section>
      )}

      <div className="table-wrap">
        <table data-testid="machines-table">
          <thead>
            <tr>
              <th className="num">#</th>
              <th>Machine</th>
              <th>Status</th>
              <th className="num">Queue</th>
              <th className="num">Runs / failures (30d)</th>
              <th className="num">Spend (30d)</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.map((m) => (
              <tr key={m.id} data-testid={`machine-row-${m.id}`}>
                <td className="num">{m.id}</td>
                <td>{m.name.replace(/ Machines?$/, "")}</td>
                <td>
                  <span className={statusBadge(m.status)}>{m.status}</span>
                </td>
                <td className="num">{m.queue.length}</td>
                <td className="num">
                  {m.runs_30d} / {m.failures_30d}
                </td>
                <td className="num">${m.spend_30d_usd.toFixed(4)}</td>
                <td>
                  {/* THE BUTTON WORKED AND LOOKED LIKE IT DID NOT.
                      The detail panel renders below a forty-five row table, so opening row three
                      rendered a panel far below the fold, with nothing on the row itself changing.
                      The operator's reading was that the button was broken; what was broken was
                      that nothing acknowledged the press. Three fixes, all of them small: the row
                      marks itself, the button says what it will do next, and the panel is scrolled
                      to rather than left to be found. */}
                  <button
                    type="button"
                    className="link-button"
                    data-testid={`machine-open-${m.id}`}
                    aria-expanded={selected === m.id}
                    onClick={() => setSelected(selected === m.id ? null : m.id)}
                  >
                    {selected === m.id ? "Close" : "Open"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Scrolled to on open, so the answer to "did that do anything" is that you are looking at
          it. `smooth` is skipped for anyone who has asked for reduced motion. */}
      <div ref={detailRef}>
        {selectedMachine && <MachineDetail machine={selectedMachine} onChanged={fleet.reload} />}
      </div>

      <CapabilityPanel me={me} />
    </section>
  );
}
