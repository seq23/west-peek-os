import { useEffect, useRef, useState } from "react";
import { departmentDef } from "@shared/registry/departments";
import { SKILL_LIBRARY, skillsForMachines } from "@shared/skills/library";
import { readableDate } from "../lib/dates";
import { api, useApi, type MeResponse } from "../lib/api";

/**
 * The firm's forty-five departments, what each is doing, how each works, and what employees may do.
 *
 * WHAT WAS WRONG (operator, item 25: pages "jumbled", make them read like the LP tab).
 *
 * 1. THE PAGE'S SUBSTANCE WAS BEHIND A CLICK ON A ROW. With nothing selected the page was a filter,
 *    a forty-five row table, and nothing else. Everything worth reading — queue, methods, memory,
 *    controls — appeared only after pressing Open on one row, and the panel rendered below the
 *    fold. The detail is now a named section that is always on the page and says what to do when
 *    nothing is chosen, rather than an empty region you have to discover.
 *
 * 2. THE SKILL LIBRARY WAS TWELVE NESTED DISCLOSURES — every method the firm owns was behind one —
 *    and there was a SECOND copy of it gated on `domain !== "ALL"`, which only appeared once the
 *    filter was moved off its default. That is the exact bug the comment above it claimed to have
 *    fixed, reintroduced one section lower. There is now ONE methods section; it is open; and the
 *    filter narrows it instead of revealing it.
 *
 * 3. HEADING RANKS WANDERED and the headings were noun-labels — "Queue", "Controls", "Memory",
 *    "Capabilities", "Recommended stack". A section is an h3, a thing inside a section is an h4,
 *    and each says what it answers.
 *
 * 4. `ACTIVE` / `PAUSED` were shouted at the reader in a badge, department ids were printed raw,
 *    and queue state, memory kind and capability maturity were rendered as enum values. All of it
 *    is mapped to plain words in one place at the top of the file.
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

/** The vocabulary, in one place, so the same state is never worded two ways on one page. */
const RUNNING_STATE: Record<string, string> = { ACTIVE: "Running", PAUSED: "Paused" };

const QUEUE_STATE: Record<string, string> = {
  OPEN: "waiting to be picked up",
  IN_PROGRESS: "being worked on",
  BLOCKED: "blocked",
};

const MEMORY_KIND: Record<string, string> = {
  OPERATING_NOTE: "Note",
  FAILURE: "Failure",
  CONFIG_CHANGE: "Setting changed",
  LESSON: "Lesson",
};

const MATURITY: Record<string, string> = {
  EXPERIMENTAL: "still an experiment",
  DEVELOPING: "coming along",
  MATURE: "well developed",
};

const TESTED: Record<string, string> = {
  UNTESTED: "never tested",
  FIXTURE_TESTED: "tested on a fixture",
  PROVEN_LOCAL: "proven here, not live",
  PROVEN_LIVE: "proven in live use",
};

const CONFIDENCE: Record<string, string> = { LOW: "low confidence", MEDIUM: "fair confidence", HIGH: "high confidence" };

function label(map: Record<string, string>, key: string | null | undefined): string {
  if (!key) return "—";
  return map[key] ?? key.toLowerCase().split("_").join(" ");
}

function runningBadge(status: string): string {
  return status === "PAUSED" ? "badge badge-gate" : "badge badge-ok";
}

function testedBadge(state: string): string {
  if (state === "PROVEN_LIVE") return "badge badge-ok";
  if (state === "PROVEN_LOCAL" || state === "FIXTURE_TESTED") return "badge badge-gate";
  return "badge badge-bad";
}

/** "Marketing / PR / Content Machines" is how the registry names it; nobody says "Machines". */
function departmentName(name: string): string {
  return name.replace(/ Machines?$/, "");
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
 * The methods one department's employees follow, from both sources, and a way to add another.
 *
 * TWO SOURCES, NEVER BLENDED. Reviewed methods live in the repository and change through a pull
 * request; written ones were typed here by a partner. Both are followed. A reader who cannot tell
 * them apart cannot judge either, so each is labelled.
 *
 * A DRAFT IS NOT IN USE, and the page says so on the row rather than in a legend somewhere. A
 * method is read by every employee on this department on every run; a sentence that became a live
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
    setMessage(res.status === 200 ? "Adopted. Every employee here reads it before working now." : res.data?.detail ?? `Refused (HTTP ${res.status}).`);
    written.reload();
  }

  return (
    <div data-testid={`machine-methods-${machineKey}`}>
      {reviewed.length === 0 && mine.length === 0 && (
        <p className="state-empty">
          Nothing is written down for this department yet. Its employees work from their own
          judgement and the firm's general standards. Anything you write below becomes the method
          they read first.
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

      {/* Secondary to reading the methods, and inside a section that is already on screen. */}
      <details>
        <summary>Add a method for this department</summary>
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

/**
 * One department, opened.
 *
 * The machine's own name is an h4 inside the card because the page-level heading above it already
 * names what you are looking at. Nothing here goes deeper than h4.
 */
function MachineDetail({ machine, onChanged, canAdopt }: { machine: MachineRow; onChanged: () => void; canAdopt: boolean }) {
  const [message, setMessage] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [memo, setMemo] = useState("");
  const detail = useApi<{ memory: Array<{ id: string; kind: string; body: string; created_at: string }>; state_changes: Array<{ id: string; from_status: string; to_status: string; reason: string }>; dependencies: Array<{ id: string; depends_on_name: string; kind: string }> }>(
    `/api/machines/${machine.id}/state`,
  );

  return (
    <section className="card" data-testid={`machine-detail-${machine.id}`}>
      <p>
        <strong>{departmentName(machine.name)}</strong>{" "}
        <span className={runningBadge(machine.status)}>{label(RUNNING_STATE, machine.status)}</span>
      </p>
      <p className="small">{machine.purpose}</p>
      <p className="muted small">
        Part of {departmentDef(machine.domain_id).name} · {machine.runs_30d} run{machine.runs_30d === 1 ? "" : "s"} in the last 30
        days, {machine.failures_30d} of them failed · ${machine.spend_30d_usd.toFixed(4)} spent
        {machine.sla_target ? ` · expected turnaround ${machine.sla_target}` : ""}
      </p>
      {machine.pause_reason && <p className="muted small">Paused because: {machine.pause_reason}</p>}
      {machine.model_policy?.preferred_model && (
        <p className="muted small">
          Work here prefers {machine.model_policy.preferred_provider_key}'s {machine.model_policy.preferred_model}.
        </p>
      )}

      <h4>Who works here</h4>
      <p className="small">
        {machine.employees.length > 0
          ? machine.employees.map((e) => e.name).join(", ")
          : "Nobody is seated here yet, so work routed here waits for a person to pick it up."}
      </p>

      {/*
        THE METHODS THIS DEPARTMENT'S EMPLOYEES FOLLOW, on the department itself.
        The firm-wide library lower down answers "what does West Peek know" and not "what does THIS
        department work by" — and the second is the question somebody has when they have opened one.
      */}
      <h4>How this department works</h4>
      <MachineMethods machineKey={machine.key} canAdopt={canAdopt} />

      <h4>What is waiting to be done</h4>
      <ul className="card-list small" data-testid={`machine-queue-${machine.id}`}>
        {machine.queue.map((q) => (
          <li key={q.id}>
            {q.title} — <span className="muted">{label(QUEUE_STATE, q.state)}</span>
          </li>
        ))}
        {machine.queue.length === 0 && <li className="state-empty">Nothing is waiting. Work arrives here when a capture is routed to it.</li>}
      </ul>

      <h4>What has gone wrong lately</h4>
      <ul className="card-list small" data-testid={`machine-failures-${machine.id}`}>
        {machine.recent_failures.map((f) => (
          <li key={f.id}>
            {f.reason} — {readableDate(f.at)}
          </li>
        ))}
        {machine.recent_failures.length === 0 && <li className="state-empty">Nothing has failed here in the last 30 days.</li>}
      </ul>

      <h4>Stopping it, and leaving a note</h4>
      <p className="muted small">
        Pausing is real: while it is paused the server refuses to route work here and refuses to
        spend on it. The reason you type is kept with the change.
      </p>
      <div className="form-row">
        <input
          aria-label="Why — kept with this change" data-testid={`machine-reason-${machine.id}`}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Why (required)"
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
                  ? "Resumed. Work and spending are allowed here again."
                  : "Paused. The server now refuses work routing and AI spend for this department."
                : `Refused: ${res.data?.detail ?? res.data?.error ?? res.status}`,
            );
            onChanged();
            detail.reload();
          }}
        >
          {machine.status === "PAUSED" ? "Start it again" : "Pause it"}
        </button>
      </div>

      <div className="form-row">
        <input aria-label="A note to keep on this department" data-testid={`machine-memo-${machine.id}`} value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="Anything whoever works here should know" />
        <button
          type="button"
          data-testid={`machine-memo-submit-${machine.id}`}
          onClick={async () => {
            const res = await api(`/api/machines/${machine.id}/memory`, { method: "POST", body: { kind: "OPERATING_NOTE", body: memo } });
            setMessage(res.status === 201 ? "Kept. Everyone working here sees it." : `Refused (HTTP ${res.status}).`);
            setMemo("");
            detail.reload();
          }}
        >
          Keep this note
        </button>
      </div>
      {message && <p className="notice small" role="status" data-testid={`machine-message-${machine.id}`}>{message}</p>}

      <h4>What it has been told</h4>
      <ul className="card-list small" data-testid={`machine-memory-${machine.id}`}>
        {(detail.data?.memory ?? []).map((m) => (
          <li key={m.id}>
            <strong>{label(MEMORY_KIND, m.kind)}</strong> — {m.body} <span className="muted">{readableDate(m.created_at)}</span>
          </li>
        ))}
        {(detail.data?.memory ?? []).length === 0 && (
          <li className="state-empty">Nothing has been written down here. Notes you keep above stay with the department.</li>
        )}
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

  const group = (title: string, blurb: string, rows: CapabilityRow[], testid: string, emptyText: string) => (
    <section className="module-card" data-testid={testid}>
      <h4>
        {title} <span className="module-count">{rows.length}</span>
      </h4>
      <p className="muted small">{blurb}</p>
      <ul className="card-list small">
        {rows.map((c) => (
          <li key={c.id}>
            <strong>{c.name}</strong> <span className="badge">{label(MATURITY, c.maturity)}</span>{" "}
            <span className={testedBadge(c.tested_state)}>{label(TESTED, c.tested_state)}</span>
            <br />
            <span className="muted">
              {label(CONFIDENCE, c.confidence)} ·{" "}
              {c.success_rate === null
                ? "nobody has recorded how it went"
                : `worked ${c.success_rate}% of the ${c.after_action_count} time${c.after_action_count === 1 ? "" : "s"} it was used`}
              {c.cost_estimate_usd !== null ? ` · about $${c.cost_estimate_usd} a time (${c.cost_basis})` : ""}
              {c.assignments.length > 0
                ? ` · granted in ${c.assignments.length} place${c.assignments.length === 1 ? "" : "s"}`
                : " · not granted to anybody"}
              {c.build_vs_buy ? ` · we ${c.build_vs_buy.decision.toLowerCase()}${c.build_vs_buy.vendor ? ` (${c.build_vs_buy.vendor})` : ""}` : ""}
            </span>
          </li>
        ))}
        {rows.length === 0 && <li className="state-empty">{emptyText}</li>}
      </ul>
    </section>
  );

  return (
    <section data-testid="capabilities-panel">
      {/* WHAT A CAPABILITY IS, said before three columns of them.
          The operator's question was literally "what are capabilities and what do I do with them",
          asked while looking at Active / Bench / Archive with no statement anywhere of what any of
          it meant. Three buckets of unexplained nouns is not a control surface. */}
      <h3>What employees are allowed to do</h3>
      <p className="small">
        A <strong>capability</strong> is one named ability — reading a live web page, searching
        sources, drafting an outbound message. An employee can only do what they have been granted,
        so this is where the workforce's reach is widened or narrowed. It is separate from a
        department, which is <em>where</em> somebody works, and from a method, which is <em>how</em>
        this firm prefers it done.
      </p>
      <div className="module-grid">
        {group(
          "In use",
          "Granted to somebody. This is the firm's current reach.",
          caps.data?.active ?? [],
          "capabilities-active",
          "Nothing is granted to anybody yet.",
        )}
        {group(
          "Ready, not switched on",
          "Defined, but nobody has it. Available to turn on.",
          caps.data?.bench ?? [],
          "capabilities-bench",
          "Nothing is waiting to be switched on.",
        )}
        {group(
          "Retired",
          "No longer used. Kept, because what an employee once could do is part of explaining what they did.",
          caps.data?.archive ?? [],
          "capabilities-archive",
          "Nothing has been retired.",
        )}
      </div>

      <section className="card" data-testid="recommended-stack">
        <h4>Which of these has actually worked</h4>
        <p className="muted small">{caps.data?.definitions.recommended_stack}</p>
        <ul className="card-list small">
          {(caps.data?.recommended_stack ?? []).map((r) => (
            <li key={r.capability_key}>
              {r.name} — {r.why}
            </li>
          ))}
          {(caps.data?.recommended_stack ?? []).length === 0 && (
            <li className="state-empty">
              Nothing to recommend yet: no capability in use has had a single outcome recorded against it.
            </li>
          )}
        </ul>
      </section>

      <section className="card">
        <h4>Add one</h4>
        <p className="muted small">
          Something well developed and something proven are different things — a capability can be
          both well built and never tested, so a new one starts untested and cannot be granted to
          anybody until something has been proven.
        </p>
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
                ? `Registered “${name}”. It is ready but not switched on, and never tested — nobody can be granted it until something is proven.`
                : `Refused: ${res.data?.detail ?? res.data?.error ?? res.status}`,
            );
            setKey("");
            setName("");
            caps.reload();
          }}
        >
          <label>
            What it is called{" "}
            <input data-testid="capability-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Read a live web page" />
          </label>
          <label>
            Short name for it{" "}
            <input data-testid="capability-key" value={key} onChange={(e) => setKey(e.target.value)} placeholder="read_live_web_page" />
          </label>
          <button type="submit" className="btn-strong" data-testid="capability-submit">
            Add it
          </button>
        </form>
        {message && <p className="notice" data-testid="capability-message" role="status">{message}</p>}
      </section>
      <p className="muted small">Signed in as {me.fullName}.</p>
    </section>
  );
}

export function MachinesPage({ me }: { me: MeResponse }) {
  const fleet = useApi<{ machines: MachineRow[]; note: string }>("/api/machines/control-center");
  const [selected, setSelected] = useState<number | null>(null);
  const detailRef = useRef<HTMLDivElement | null>(null);
  const [domain, setDomain] = useState("ALL");

  useEffect(() => {
    if (selected === null || !detailRef.current) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    detailRef.current.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  }, [selected]);

  if (fleet.loading && !fleet.data) return <p data-testid="machines-loading">Loading the departments…</p>;
  if (!fleet.data) return <p data-testid="machines-error">Could not load the departments (HTTP {fleet.status ?? "?"}).</p>;

  const machines = fleet.data.machines;
  const domains = [...new Set(machines.map((m) => m.domain_id))].sort();
  const shown = domain === "ALL" ? machines : machines.filter((m) => m.domain_id === domain);
  const selectedMachine = selected === null ? null : machines.find((m) => m.id === selected) ?? null;

  // The methods library follows the same filter as the table, so choosing an area narrows the
  // whole page rather than revealing a section that was hidden until then.
  const shownKeys = new Set(shown.map((m) => m.key));
  const libraryForShown = SKILL_LIBRARY.filter((dept) => shownKeys.has(dept.machineKey));
  const methodCount = libraryForShown.reduce((n, dept) => n + dept.skills.length, 0);

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
          {machines.length} machines, grouped into {domains.length} areas ·{" "}
          {machines.filter((m) => m.status === "PAUSED").length} paused. {fleet.data.note}
        </p>
      </div>

      <h3>Every department, and how it is running</h3>
      <p className="small">
        Choose an area to narrow this page — the table and the methods below both follow it. Open a
        department to see who works there, what it is doing, and to pause it.
      </p>
      <div className="form-row">
        <label>
          Area{" "}
          <select data-testid="machines-domain" value={domain} onChange={(e) => setDomain(e.target.value)}>
            <option value="ALL">Everything ({machines.length})</option>
            {domains.map((d) => (
              <option key={d} value={d}>
                {departmentDef(d).name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {domain !== "ALL" && <p className="muted small">{departmentDef(domain).what}</p>}

      <div className="table-wrap">
        <table data-testid="machines-table">
          <thead>
            <tr>
              <th className="num">#</th>
              <th>Department</th>
              <th>Running?</th>
              <th className="num">Waiting</th>
              <th className="num">Runs / failures (30d)</th>
              <th className="num">Spent (30d)</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.map((m) => (
              <tr key={m.id} data-testid={`machine-row-${m.id}`}>
                <td className="num">{m.id}</td>
                <td>{departmentName(m.name)}</td>
                <td>
                  <span className={runningBadge(m.status)}>{label(RUNNING_STATE, m.status)}</span>
                </td>
                <td className="num">{m.queue.length}</td>
                <td className="num">
                  {m.runs_30d} / {m.failures_30d}
                </td>
                <td className="num">${m.spend_30d_usd.toFixed(4)}</td>
                <td>
                  {/* THE BUTTON WORKED AND LOOKED LIKE IT DID NOT.
                      The detail renders below a forty-five row table, so opening row three rendered
                      a panel far below the fold with nothing on the row itself changing. The
                      operator's reading was that the button was broken; what was broken was that
                      nothing acknowledged the press. The row marks itself, the button says what it
                      will do next, and the panel is scrolled to rather than left to be found. */}
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
            {shown.length === 0 && (
              <tr>
                <td colSpan={7} className="state-empty">
                  No department sits in this area. Choose Everything to see all {machines.length}.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* ALWAYS A SECTION, never an empty region below a table. With nothing chosen the page used
          to end here silently, so the substance of the page was reachable only by guessing that a
          row could be opened. */}
      <h3>{selectedMachine ? `Inside ${departmentName(selectedMachine.name)}` : "Inside one department"}</h3>
      <div ref={detailRef}>
        {selectedMachine ? (
          <MachineDetail
            machine={selectedMachine}
            onChanged={fleet.reload}
            canAdopt={me.roles.includes("MANAGING_PARTNER")}
          />
        ) : (
          <p className="state-empty" data-testid="machine-none-open">
            Nothing is open. Press Open on any row above to see who works there, what is waiting,
            what has gone wrong, and the controls that stop it.
          </p>
        )}
      </div>

      {/* ONE METHODS SECTION, OPEN.

          There used to be two: a firm-wide library of twelve nested <details>, and a second copy
          gated on `domain !== "ALL"` which appeared only once the filter was moved off its default.
          So the operator's verdict was that nothing on this tab had changed, and they were right —
          the one thing that had was behind a control nobody had reason to touch. Now every
          department and every method title is on the page, the filter narrows this list too, and
          only the lines of a method itself are folded away. */}
      <h3>How each department works</h3>
      <p className="small">
        {methodCount} method{methodCount === 1 ? "" : "s"} across {libraryForShown.length} department
        {libraryForShown.length === 1 ? "" : "s"} — what an employee seated there reads before
        working, and so can you. Guidelines, not rules: the rules are enforced in code and cannot be
        broken from a prompt.
      </p>
      {libraryForShown.length === 0 && (
        <p className="state-empty" data-testid="skills-none">
          No department in this area has written its methods down. Employees seated there work from
          their own judgement — which is how the whole firm worked until recently, and why nothing
          could be reviewed. Open a department above to write the first one.
        </p>
      )}
      {libraryForShown.map((dept) => {
        const machine = machines.find((m) => m.key === dept.machineKey);
        const seated = (machine?.employees ?? []).filter((e) => e.status !== "RETIRED");
        return (
          <section className="card" key={dept.machineKey} data-testid={`skills-${dept.machineKey}`}>
            <h4>{machine ? departmentName(machine.name) : dept.machineKey}</h4>
            <p className="muted small">
              {dept.skills.length} method{dept.skills.length === 1 ? "" : "s"}
              {seated.length > 0 ? ` · read by ${seated.map((e) => e.name).join(", ")}` : " · nobody seated here yet"}
            </p>
            <ul className="card-list small">
              {dept.skills.map((sk) => (
                <li key={sk.key} data-testid={`skill-${sk.key}`}>
                  <strong>{sk.title}</strong> <span className="muted">— {sk.when}</span>
                  {/* The title and when-to-use it are always visible; only the method's own lines
                      fold, because a hundred methods at four lines each is a page nobody reads. */}
                  <details>
                    <summary className="muted">How it is done</summary>
                    <ul className="card-list small">
                      {sk.guidance.map((g, i) => (
                        <li key={i}>{g.trim()}</li>
                      ))}
                    </ul>
                  </details>
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      <CapabilityPanel me={me} />
    </section>
  );
}
