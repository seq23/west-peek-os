import { useEffect, useRef, useState } from "react";
import { departmentDef } from "@shared/registry/departments";
import { SKILL_LIBRARY, skillsForMachines } from "@shared/skills/library";
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


interface WrittenSkill {
  id: string;
  title: string;
  when: string;
  guidance: string[];
  status: "DRAFT" | "ADOPTED";
  source_text: string;
}

/**
 * The methods one machine's employees follow, from both sources, and a way to add another.
 *
 * TWO SOURCES, NEVER BLENDED. Reviewed methods live in the repository and change through a pull
 * request; written ones were typed here by a partner. Both are followed. A reader who cannot tell
 * them apart cannot judge either, so each is labelled and the reviewed ones link out to the file.
 *
 * A DRAFT IS NOT IN USE, and the page says so on the row rather than in a legend somewhere. A
 * method is read by every employee on this machine on every run; a sentence that became a live
 * instruction without anybody reading it in final form is the failure this state exists to prevent.
 */
function MachineMethods({ machineKey, canAdopt }: { machineKey: string; canAdopt: boolean }) {
  const reviewed = skillsForMachines([machineKey]);
  const written = useApi<{ machines: Array<{ machine_key: string; written: WrittenSkill[] }> }>("/api/firm-skills");
  const [plain, setPlain] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const mine = written.data?.machines.find((m) => m.machine_key === machineKey)?.written ?? [];

  async function draft() {
    if (plain.trim().length < 12) {
      setMessage("Write a sentence or two about how you want this done.");
      return;
    }
    setBusy(true);
    setMessage(null);
    const res = await api<{ skill?: { title: string }; detail?: string }>("/api/firm-skills/draft", {
      method: "POST",
      body: { machine_key: machineKey, plain_english: plain.trim() },
    });
    setBusy(false);
    if (res.status !== 201) {
      setMessage(res.data?.detail ?? `That did not work (HTTP ${res.status}).`);
      return;
    }
    setPlain("");
    setMessage(`Drafted "${res.data?.skill?.title}". Read it below — nothing follows it until you adopt it.`);
    written.reload();
  }

  async function adopt(id: string) {
    const res = await api<{ detail?: string }>(`/api/firm-skills/${id}/adopt`, { method: "POST" });
    setMessage(res.status === 200 ? "Adopted. Every employee on this machine reads it before working now." : res.data?.detail ?? `Refused (HTTP ${res.status}).`);
    written.reload();
  }

  return (
    <div data-testid={`machine-methods-${machineKey}`}>
      {reviewed.length === 0 && mine.length === 0 && (
        <p className="muted small">
          No methods are written down for this machine yet. Its employees work from their own judgement and the
          firm's general standards.
        </p>
      )}

      {reviewed.length > 0 && (
        <>
          {/* Shown in full right here rather than linked out. A hardcoded repository URL is one
              more thing to rot, and the method is three lines — there is nothing to go and read. */}
          <p className="muted small">Reviewed — these live in the repository and change through a pull request.</p>
          <ul className="card-list small">
            {reviewed.map((sk) => (
              <li key={sk.key}>
                <strong>{sk.title}</strong> — {sk.when}
                <ul>
                  {sk.guidance.map((g, i) => (
                    <li key={i} className="muted">{g}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </>
      )}

      {mine.length > 0 && (
        <>
          <p className="muted small">Written by the partners</p>
          <ul className="card-list small">
            {mine.map((sk) => (
              <li key={sk.id} data-testid={`written-skill-${sk.id}`}>
                <strong>{sk.title}</strong> — {sk.when}{" "}
                {sk.status === "DRAFT" && <span className="badge badge-gate">draft — not in use</span>}
                <ul>
                  {sk.guidance.map((g, i) => (
                    <li key={i} className="muted">{g}</li>
                  ))}
                </ul>
                <p className="muted small">You wrote: “{sk.source_text}”</p>
                {sk.status === "DRAFT" && canAdopt && (
                  <button type="button" data-testid={`adopt-skill-${sk.id}`} onClick={() => adopt(sk.id)}>
                    This is what I meant — adopt it
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      <details>
        <summary>Add a method for this machine</summary>
        <p className="muted small">
          Write plainly how you want this work done. An employee turns it into the method the others follow, and
          you read that before it is used. Your words are kept exactly as you wrote them.
        </p>
        <textarea
          data-testid={`skill-plain-${machineKey}`}
          aria-label="How you want this work done"
          rows={3}
          style={{ width: "100%" }}
          value={plain}
          onChange={(e) => setPlain(e.target.value)}
          placeholder="e.g. Before screening any company, find out who actually pays for it today."
        />
        <button type="button" data-testid={`skill-draft-${machineKey}`} disabled={busy} onClick={draft}>
          {busy ? "Drafting…" : "Draft it"}
        </button>
        {message && <p className="notice small" role="status">{message}</p>}
      </details>
    </div>
  );
}

function MachineDetail({ machine, onChanged, canAdopt }: { machine: MachineRow; onChanged: () => void; canAdopt: boolean }) {
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

      {/*
        THE METHODS THIS MACHINE'S EMPLOYEES FOLLOW, on the machine itself.
        The firm-wide library card lower down already listed every method, which answered "what does
        West Peek know" and not "what does THIS machine work by" — and the second is the question
        somebody has when they have opened a machine. Both sources appear, marked, because a method
        reviewed in a pull request and a method a partner wrote on Tuesday are both followed and a
        reader should never have to guess which they are reading.
      */}
      <h4>Methods its employees follow</h4>
      <MachineMethods machineKey={machine.key} canAdopt={canAdopt} />

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
      {/* WHAT A CAPABILITY IS, said before three columns of them.
          The operator's question was literally "what are capabilities and what do I do with them",
          asked while looking at Active / Bench / Archive with no statement anywhere of what any of
          it meant. Three buckets of unexplained nouns is not a control surface. */}
      <div className="home-section-head">
        <h3>Capabilities</h3>
        <span className="muted small">specific things an employee is allowed to do</span>
      </div>
      <p className="small">
        A <strong>capability</strong> is one named ability — reading a live web page, searching
        sources, drafting an outbound message. An employee can only do what they have been granted,
        so this is where the workforce's reach is widened or narrowed. It is separate from a
        department, which is <em>where</em> somebody works, and from a skill, which is <em>how</em>
        this firm prefers it done.
      </p>
      <ul className="card-list small">
        <li><strong>Active</strong> — granted and in use. This is the firm's current reach.</li>
        <li><strong>Bench</strong> — defined but not granted to anyone. Available to turn on.</li>
        <li><strong>Archive</strong> — retired. Kept because a capability an employee once had is
          part of explaining what they did.</li>
      </ul>
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

      {/* THE SKILL LIBRARY, and it used to be invisible.

          It only rendered when a specific area was chosen from the filter, and the filter defaults
          to "Everything" — so the operator's verdict was that nothing on this tab had changed, and
          they were right: the one thing that had was behind a control nobody had reason to touch.
          Hiding the best part of a page behind an optional filter is the same mistake as putting a
          legend at the bottom.

          Now it is always on the page, and choosing an area narrows it rather than revealing it. */}
      <section className="card" data-testid="skill-library-all">
        <div className="home-section-head">
          <h3>The firm's methods</h3>
          <span className="muted small">
            what employees seated in each department read before working
          </span>
        </div>
        <p className="muted small">
          Guidelines, not rules — the rules are enforced in code and cannot be broken from a prompt.
          A department with none written down says so; that is how the whole firm worked until
          recently, and why nothing could be reviewed.
        </p>
        {SKILL_LIBRARY.map((dept) => {
          const machine = fleet.data!.machines.find((m) => m.key === dept.machineKey);
          const seated = (machine?.employees ?? []).filter((e) => e.status !== "RETIRED");
          return (
            <details key={dept.machineKey} data-testid={`skills-${dept.machineKey}`}>
              <summary>
                <strong>{machine?.name.replace(/ Machines?$/, "") ?? dept.machineKey}</strong>{" "}
                <span className="muted small">
                  {dept.skills.length} method{dept.skills.length === 1 ? "" : "s"}
                  {seated.length > 0 ? ` · read by ${seated.map((e) => e.name).join(", ")}` : " · nobody seated here yet"}
                </span>
              </summary>
              <ul className="card-list small">
                {dept.skills.map((sk) => (
                  <li key={sk.key}>
                    <strong>{sk.title}</strong> <span className="muted small">{sk.when}</span>
                    <ul className="card-list small">
                      {sk.guidance.map((g, i) => (
                        <li key={i}>{g.trim()}</li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </details>
          );
        })}
      </section>

      {/* The same library, narrowed, when an area is chosen.
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
        {selectedMachine && (
          <MachineDetail
            machine={selectedMachine}
            onChanged={fleet.reload}
            canAdopt={me.roles.includes("MANAGING_PARTNER")}
          />
        )}
      </div>

      <CapabilityPanel me={me} />
    </section>
  );
}
