import { useState } from "react";
import { api, useApi, type MeResponse } from "../lib/api";

/**
 * Employee Lounge + Digital Office (P15; GAP-01, GAP-10, GAP-11).
 *
 * The workforce as an operating surface: who exists, what department they sit in, what
 * they are working on right now, what it cost, how they have performed, and the controls
 * a human actually holds over them. Activation remains the reserved receipt path — this
 * page requests it and shows the cap, but never bypasses it.
 */

interface LoungeEmployee {
  id: string;
  name: string;
  role: string;
  department: string;
  avatar_initials: string;
  brief: string;
  manager_employee_id: string | null;
  status: string;
  primary_machines: string[];
  assigned_machine_ids: number[];
  tool_scopes: string[];
  current_work: Array<{ id: string; title: string; state: string; priority: string }>;
  recent_runs: Array<{ id: string; purpose: string; status: string; created_at: string; cost_usd: number }>;
  runs_30d: number;
  blocked_runs_30d: number;
  cost_30d_usd: number;
  latest_snapshot_id: string | null;
}

interface LoungeResponse {
  employees: LoungeEmployee[];
  departments: string[];
  active_count: number;
  max_active: number;
  activation_law: string;
}

interface EmployeeDetail {
  employee: { id: string; name: string; role: string; status: string; prompt_version: string };
  profile: { department: string; brief: string; manager_employee_id: string | null } | null;
  snapshots: Array<{
    id: string;
    period_start: string;
    period_end: string;
    runs_total: number;
    runs_completed: number;
    runs_blocked: number;
    outputs_accepted: number;
    outputs_quarantined: number;
    cost_usd: number;
    cost_per_accepted_output: number | null;
    failure_patterns_json: string;
    computed_at: string;
  }>;
  reviews: Array<{ id: string; finding: string; disposition: string; created_at: string }>;
  status_history: Array<{ id: string; from_status: string; to_status: string; reason: string; created_at: string }>;
  current_work: Array<{ id: string; title: string; state: string }>;
  recent_runs: Array<{ id: string; purpose: string; status: string; failure_reason: string | null; cost_usd: number }>;
  scorecard_definition: Record<string, string>;
}

function statusBadge(status: string): string {
  if (status === "ACTIVE") return "badge badge-ok";
  if (status === "RESTRICTED" || status === "RETIRED") return "badge badge-bad";
  if (status === "PAUSED") return "badge badge-gate";
  return "badge";
}

function EmployeeDetailPanel({ id, me, onChanged }: { id: string; me: MeResponse; onChanged: () => void }) {
  const detail = useApi<EmployeeDetail>(`/api/workforce/employees/${id}`);
  const [message, setMessage] = useState<string | null>(null);
  const [finding, setFinding] = useState("");
  const [disposition, setDisposition] = useState("CONTINUE");
  const isMp = me.roles.includes("MANAGING_PARTNER");

  if (detail.loading && !detail.data) return <p>Loading employee…</p>;
  if (!detail.data) return <p className="muted">Could not load this employee.</p>;
  const d = detail.data;
  const latest = d.snapshots[0];

  const refresh = () => {
    detail.reload();
    onChanged();
  };

  return (
    <section className="card" data-testid={`employee-detail-${id}`}>
      <h3>
        {d.employee.name} — {d.employee.role} <span className={statusBadge(d.employee.status)}>{d.employee.status}</span>
      </h3>
      <p className="muted small">
        {d.profile?.department ?? "unassigned department"} · prompt {d.employee.prompt_version}
        {d.profile?.manager_employee_id ? ` · reports to ${d.profile.manager_employee_id}` : ""}
      </p>

      <h4>Current work</h4>
      <ul className="card-list small" data-testid={`employee-work-${id}`}>
        {d.current_work.map((w) => (
          <li key={w.id}>
            {w.title} — <code>{w.state}</code>
          </li>
        ))}
        {d.current_work.length === 0 && <li className="state-empty">No open work assigned.</li>}
      </ul>

      <h4>Recent governed runs</h4>
      <ul className="card-list small" data-testid={`employee-runs-${id}`}>
        {d.recent_runs.map((r) => (
          <li key={r.id}>
            <code>{r.status}</code> {r.purpose} — ${r.cost_usd.toFixed(4)}
            {r.failure_reason ? ` · ${r.failure_reason}` : ""}
          </li>
        ))}
        {d.recent_runs.length === 0 && <li className="state-empty">No runs recorded for this employee.</li>}
      </ul>

      <h4>Scorecard</h4>
      {latest ? (
        <div data-testid={`employee-scorecard-${id}`}>
          <p className="small">
            {latest.period_start.slice(0, 10)} → {latest.period_end.slice(0, 10)}: {latest.runs_total} run(s),{" "}
            {latest.runs_completed} completed, {latest.runs_blocked} blocked, {latest.outputs_accepted} accepted,{" "}
            {latest.outputs_quarantined} still quarantined. Cost ${latest.cost_usd.toFixed(4)}
            {latest.cost_per_accepted_output !== null
              ? ` · $${latest.cost_per_accepted_output.toFixed(4)} per accepted output`
              : " · no accepted output, so cost-per-output is undefined"}
            .
          </p>
          {(JSON.parse(latest.failure_patterns_json) as Array<{ reason: string; count: number }>).length > 0 && (
            <p className="small muted">
              Failure patterns:{" "}
              {(JSON.parse(latest.failure_patterns_json) as Array<{ reason: string; count: number }>)
                .map((p) => `${p.reason} ×${p.count}`)
                .join(", ")}
            </p>
          )}
          <p className="muted small">{d.scorecard_definition.not_measured}</p>
        </div>
      ) : (
        <p className="state-empty">No scorecard computed yet.</p>
      )}
      <button
        type="button"
        data-testid={`employee-compute-${id}`}
        onClick={async () => {
          const res = await api(`/api/workforce/employees/${id}/scorecard`, { method: "POST", body: {} });
          setMessage(res.status === 201 ? "Scorecard computed from run and approval history." : `Refused (HTTP ${res.status}).`);
          refresh();
        }}
      >
        Compute scorecard (last 30 days)
      </button>

      <h4>Lifecycle</h4>
      <p className="muted small">
        Raising an employee to ACTIVE runs the reserved approval receipt on the AI page. The controls here only lower
        authority, so they fail safe.
      </p>
      <div className="form-row">
        {["PAUSED", "RESTRICTED", "RETIRED"].map((s) => (
          <button
            key={s}
            type="button"
            data-testid={`employee-lifecycle-${s.toLowerCase()}-${id}`}
            disabled={d.employee.status === s || d.employee.status === "RETIRED"}
            onClick={async () => {
              const res = await api<{ error?: string; detail?: string }>(`/api/workforce/employees/${id}/lifecycle`, {
                method: "POST",
                body: { to_status: s, reason: `operator action from the lounge (${me.fullName})` },
              });
              setMessage(res.status === 200 ? `Now ${s}.` : `Refused: ${res.data?.detail ?? res.data?.error ?? res.status}`);
              refresh();
            }}
          >
            {s}
          </button>
        ))}
        {d.employee.status !== "ACTIVE" && d.employee.status !== "RETIRED" && (
          <button
            type="button"
            data-testid={`employee-request-activation-${id}`}
            onClick={async () => {
              const res = await api<{ id?: string; error?: string }>(`/api/ai/employees/${id}/request-activation`, {
                method: "POST",
                body: { reason: "requested from the lounge" },
              });
              setMessage(
                res.status === 201
                  ? `Activation approval card ${res.data?.id} opened. A Managing Partner must approve it before activation.`
                  : `Refused: ${res.data?.error ?? res.status}`,
              );
            }}
          >
            Request activation
          </button>
        )}
      </div>

      {isMp && (
        <>
          <h4>Manager review</h4>
          <form
            data-testid={`employee-review-form-${id}`}
            onSubmit={async (e) => {
              e.preventDefault();
              const res = await api<{ error?: string }>(`/api/workforce/employees/${id}/reviews`, {
                method: "POST",
                body: { finding, disposition, snapshot_id: latest?.id },
              });
              setMessage(res.status === 201 ? `Review recorded (${disposition}).` : `Refused: ${res.data?.error ?? res.status}`);
              setFinding("");
              refresh();
            }}
          >
            <div className="form-row">
              <input
                data-testid={`employee-review-finding-${id}`}
                value={finding}
                onChange={(e) => setFinding(e.target.value)}
                placeholder="What did you observe?"
              />
              <select data-testid={`employee-review-disposition-${id}`} value={disposition} onChange={(e) => setDisposition(e.target.value)}>
                {["CONTINUE", "IMPROVEMENT_PLAN", "RETRAIN", "RESTRICT", "RETIRE"].map((x) => (
                  <option key={x} value={x}>
                    {x}
                  </option>
                ))}
              </select>
              <button type="submit" className="btn-strong" data-testid={`employee-review-submit-${id}`}>
                Record review
              </button>
            </div>
          </form>
          <ul className="card-list small" data-testid={`employee-reviews-${id}`}>
            {d.reviews.map((r) => (
              <li key={r.id}>
                <code>{r.disposition}</code> {r.finding} — {r.created_at}
              </li>
            ))}
            {d.reviews.length === 0 && <li className="state-empty">No reviews recorded.</li>}
          </ul>
        </>
      )}

      <h4>Lifecycle history</h4>
      <ul className="card-list small">
        {d.status_history.map((h) => (
          <li key={h.id}>
            {h.from_status} → {h.to_status} — {h.reason} ({h.created_at})
          </li>
        ))}
        {d.status_history.length === 0 && <li className="muted">Never changed from its seeded state.</li>}
      </ul>

      {message && <p data-testid={`employee-message-${id}`}>{message}</p>}
    </section>
  );
}

function RoomsPanel({ me }: { me: MeResponse }) {
  const rooms = useApi<{ rooms: Array<{ id: string; room_key: string; name: string; department: string; message_count: number }>; rule: string }>(
    "/api/workforce/rooms",
  );
  const [selected, setSelected] = useState<string | null>(null);
  const room = useApi<{
    room: { name: string; department: string; purpose: string };
    messages: Array<{ id: string; author_type: string; author_id: string; context_kind: string; context_id: string | null; body: string; created_at: string }>;
    members: Array<{ id: string; name: string; role: string; status: string }>;
  }>(selected ? `/api/workforce/rooms/${selected}` : null);
  const [body, setBody] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  return (
    <section data-testid="rooms-panel">
      <h3>Department rooms</h3>
      <p className="muted small">{rooms.data?.rule}</p>
      <ul className="card-list" data-testid="room-list">
        {(rooms.data?.rooms ?? []).map((r) => (
          <li key={r.id}>
            <button type="button" className="link-button" data-testid={`room-open-${r.room_key}`} onClick={() => setSelected(r.room_key)}>
              {r.name}
            </button>{" "}
            <span className="badge">{r.message_count} message(s)</span>
          </li>
        ))}
        {!rooms.loading && (rooms.data?.rooms ?? []).length === 0 && <li className="state-empty">No rooms.</li>}
      </ul>

      {selected && room.data && (
        <section className="card" data-testid="room-detail">
          <h4>{room.data.room.name}</h4>
          <p className="muted small">{room.data.room.purpose}</p>
          <p className="small">
            Members: {room.data.members.map((m) => `${m.name} (${m.status})`).join(", ") || "none"}
          </p>
          <form
            className="form-row"
            data-testid="room-announce-form"
            onSubmit={async (e) => {
              e.preventDefault();
              const res = await api<{ error?: string; detail?: string }>(`/api/workforce/rooms/${selected}/messages`, {
                method: "POST",
                body: { context_kind: "ANNOUNCEMENT", body },
              });
              setMessage(res.status === 201 ? "Announcement posted." : `Refused: ${res.data?.detail ?? res.data?.error ?? res.status}`);
              setBody("");
              room.reload();
            }}
          >
            <input
              className="field-wide" data-testid="room-announce-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={`Announcement from ${me.fullName}`}
            />
            <button type="submit" className="btn-strong" data-testid="room-announce-submit">
              Post announcement
            </button>
          </form>
          {message && <p className="notice small" data-testid="room-message">{message}</p>}
          <ul className="card-list small" data-testid="room-messages">
            {room.data.messages.map((m) => (
              <li key={m.id}>
                <code>{m.context_kind}</code> {m.author_type}:{m.author_id} — {m.body}
                {m.context_id ? ` (${m.context_id})` : ""}
              </li>
            ))}
            {room.data.messages.length === 0 && <li className="state-empty">No messages yet.</li>}
          </ul>
        </section>
      )}
    </section>
  );
}

function HandoffsPanel({ onChanged }: { onChanged: () => void }) {
  const handoffs = useApi<{ handoffs: Array<{ id: string; work_card_id: string; to_employee_id: string; reason: string; status: string; decided_by: string | null }> }>(
    "/api/workforce/handoffs",
  );
  const [message, setMessage] = useState<string | null>(null);

  return (
    <section data-testid="handoffs-panel">
      <h3>Handoffs</h3>
      <p className="muted small">An AI employee may propose moving work. A human decides, and only then does the card move.</p>
      <ul className="card-list small" data-testid="handoff-list">
        {(handoffs.data?.handoffs ?? []).map((h) => (
          <li key={h.id}>
            <code>{h.status}</code> {h.work_card_id} → {h.to_employee_id} — {h.reason}
            {h.status === "PROPOSED" && (
              <>
                {" "}
                <button
                  type="button"
                  className="link-button"
                  data-testid={`handoff-accept-${h.id}`}
                  onClick={async () => {
                    const res = await api(`/api/workforce/handoffs/${h.id}/decide`, { method: "POST", body: { decision: "ACCEPTED" } });
                    setMessage(res.status === 200 ? "Accepted; the work card moved." : `Refused (HTTP ${res.status}).`);
                    handoffs.reload();
                    onChanged();
                  }}
                >
                  Accept
                </button>{" "}
                <button
                  type="button"
                  className="link-button"
                  data-testid={`handoff-reject-${h.id}`}
                  onClick={async () => {
                    await api(`/api/workforce/handoffs/${h.id}/decide`, { method: "POST", body: { decision: "REJECTED" } });
                    setMessage("Rejected; the work card did not move.");
                    handoffs.reload();
                  }}
                >
                  Reject
                </button>
              </>
            )}
          </li>
        ))}
        {!handoffs.loading && (handoffs.data?.handoffs ?? []).length === 0 && <li className="state-empty">No handoffs proposed.</li>}
      </ul>
      {message && <p className="notice small" data-testid="handoff-message">{message}</p>}
    </section>
  );
}

export function EmployeesPage({ me }: { me: MeResponse }) {
  const lounge = useApi<LoungeResponse>("/api/workforce/lounge");
  const [department, setDepartment] = useState<string>("ALL");
  const [selected, setSelected] = useState<string | null>(null);

  if (lounge.loading && !lounge.data) return <p data-testid="lounge-loading">Loading the workforce…</p>;
  if (!lounge.data) return <p data-testid="lounge-error">Could not load the workforce (HTTP {lounge.status ?? "?"}).</p>;

  const shown =
    department === "ALL" ? lounge.data.employees : lounge.data.employees.filter((e) => e.department === department);

  return (
    <section data-testid="employees-page">
      <p data-testid="lounge-activation-law" className="muted small">
        {lounge.data.active_count} of {lounge.data.max_active} activation slots in use. {lounge.data.activation_law}
      </p>

      <div className="form-row">
        <label>
          Department{" "}
          <select data-testid="lounge-department" value={department} onChange={(e) => setDepartment(e.target.value)}>
            <option value="ALL">All ({lounge.data.employees.length})</option>
            {lounge.data.departments.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="module-grid" data-testid="lounge-grid">
        {shown.map((e) => (
          <section key={e.id} className="module-card" data-testid={`employee-card-${e.id}`}>
            <header className="module-card-head">
              <h4>
                <span className="avatar">{e.avatar_initials}</span> {e.name}
              </h4>
              <span className={statusBadge(e.status)}>{e.status}</span>
            </header>
            <p className="module-answers">{e.role}</p>
            <p className="small">{e.brief}</p>
            <p className="muted small">
              {e.department} · {e.current_work.length} open card(s) · {e.runs_30d} run(s)/30d ({e.blocked_runs_30d} blocked) · $
              {e.cost_30d_usd.toFixed(4)}
            </p>
            {e.tool_scopes.length > 0 && <p className="muted small">tools: {e.tool_scopes.join(", ")}</p>}
            <button type="button" className="link-button" data-testid={`employee-open-${e.id}`} onClick={() => setSelected(e.id)}>
              Open
            </button>
          </section>
        ))}
      </div>
      {shown.length === 0 && <p className="state-empty">No employees in this department.</p>}

      {selected && <EmployeeDetailPanel id={selected} me={me} onChanged={lounge.reload} />}

      <HandoffsPanel onChanged={lounge.reload} />
      <RoomsPanel me={me} />
    </section>
  );
}
