import { useEffect, useRef, useState } from "react";
import { api, useApi, type MeResponse } from "../lib/api";
import { personaFor } from "@shared/registry/aiEmployeePersonas";
import { portraitAlt, portraitFor } from "../lib/employeePortraits";

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
  bio: string | null;
  face: string | null;
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
  last_status_change: { to_status: string; at: string; by: string; reason: string | null } | null;
  ever_employed: boolean;
}

/**
 * Employing someone, and standing them down. One press.
 *
 * Operator direction, 21 Aug 2026: "making an employee active shouldn't be so hard. it should just
 * be one button press and an audit trail of who did it and at one time. with the option to put a
 * reason in the box for turning on or off."
 *
 * WHAT WAS HERE BEFORE only appeared for someone already hired — ACTIVE or PAUSED. Thirty of
 * thirty-one employees were neither, so for almost the whole roster this card had no hire control
 * at all: you opened the detail panel, pressed "Request activation", left for Approvals, approved
 * it, came back, and pressed a second, differently-named button. The button now appears for
 * everyone and says what it will do to THIS employee in THIS state.
 *
 * THE REASON IS OPTIONAL AND THAT IS DELIBERATE. A required box is a box people fill with "x". Left
 * empty, the trail still records who and when, which is the part that cannot be reconstructed
 * later; typed, it travels to the approval card, the decision note and the status-history row.
 *
 * Nothing here is a bypass. The server decides whether one press is enough — it is, for a partner
 * who holds the approval role, because they are the person who would have approved it. Anyone else
 * pressing this files the request and is told so.
 */
function EmploymentSwitch({
  employee,
  onChanged,
  onMessage,
}: {
  employee: LoungeEmployee;
  onChanged: () => void;
  onMessage: (m: string) => void;
}): JSX.Element {
  const [reason, setReason] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const working = employee.status === "ACTIVE";
  const retired = employee.status === "RETIRED";
  const restricted = employee.status === "RESTRICTED";

  async function press() {
    setBusy(true);
    const res = await api<{ note?: string; error?: string; detail?: string }>(
      `/api/ai/employees/${employee.id}/employ`,
      { method: "POST", body: { employed: !working, ...(reason.trim() ? { reason: reason.trim() } : {}) } },
    );
    setBusy(false);
    onMessage(
      res.status === 200 || res.status === 202
        ? res.data?.note ?? `${employee.name} updated.`
        : `Could not change ${employee.name}: ${res.data?.detail ?? res.data?.error ?? `HTTP ${res.status}`}`,
    );
    if (res.status === 200 || res.status === 202) {
      setReason("");
      setOpen(false);
    }
    onChanged();
  }

  const label = working
    ? "Working — turn off"
    : employee.ever_employed
      ? "Off — turn on"
      : "Employ";

  return (
    <div className="employment-switch">
      <div className="form-row">
        {/* RESTRICTED and RETIRED are decisions somebody made about this person. A one-press
            control must not quietly undo either, so it says so rather than pretending. */}
        {retired || restricted ? (
          <span className="muted small" data-testid={`employee-switch-locked-${employee.id}`}>
            {employee.name} is {employee.status.toLowerCase()}. That was a deliberate decision and it
            is undone in the detail panel, not with a switch.
          </span>
        ) : (
          <>
            <button
              type="button"
              className={working ? "" : "btn-strong"}
              disabled={busy}
              data-testid={`employee-toggle-${employee.id}`}
              aria-pressed={working}
              onClick={() => void press()}
            >
              {busy ? "…" : label}
            </button>
            <button
              type="button"
              className="link-button small"
              data-testid={`employee-reason-open-${employee.id}`}
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
            >
              {open ? "never mind" : "say why"}
            </button>
          </>
        )}
      </div>

      {open && !retired && !restricted && (
        <input
          className="employment-reason"
          aria-label={`Why ${employee.name} is being turned ${working ? "off" : "on"}`}
          data-testid={`employee-reason-${employee.id}`}
          value={reason}
          onChange={(ev) => setReason(ev.target.value)}
          placeholder={working ? "Why are they coming off?" : "Why are they going on?"}
          onKeyDown={(ev) => {
            if (ev.key === "Enter" && !busy) void press();
          }}
        />
      )}

      {/* Who did it and when — read back from the same history the server writes. */}
      {employee.last_status_change && (
        <p className="muted small" data-testid={`employee-trail-${employee.id}`}>
          {employee.last_status_change.to_status === "ACTIVE" ? "Employed" : employee.last_status_change.to_status.toLowerCase()}{" "}
          by {employee.last_status_change.by} on{" "}
          {new Date(employee.last_status_change.at).toLocaleString(undefined, {
            dateStyle: "medium",
            timeStyle: "short",
          })}
          {employee.last_status_change.reason ? ` — ${employee.last_status_change.reason}` : ""}
        </p>
      )}
    </div>
  );
}

interface LoungeResponse {
  employees: LoungeEmployee[];
  departments: string[];
  active_count: number;
  max_active: number;
  activation_law: string;
}

/**
 * The approved-activation card, if one exists.
 *
 * Activation needs an approved `ai_employee.activate` receipt. The card is created by
 * `request-activation` and approved on Approvals — but nothing was ever completing the final step,
 * so an approved request sat there and the employee stayed INACTIVE forever. This is that step.
 */
interface ActivationCard {
  id: string;
  action_key: string;
  object_type: string;
  object_id: string;
  state: string;
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
  // Approved activation receipts for THIS employee. `approved` is the state the receipt must be
  // in; an executed card has already been consumed.
  const approvedCards = useApi<{ approvals: ActivationCard[] }>("/api/approvals?state=approved");
  const [message, setMessage] = useState<string | null>(null);
  const [finding, setFinding] = useState("");
  const [disposition, setDisposition] = useState("CONTINUE");
  const [newTitle, setNewTitle] = useState("");
  const [retitling, setRetitling] = useState(false);
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

      {/* CHANGING A TITLE.
          A title is editorial, not authority: what an employee may DO comes from their tool scope,
          their machine seating and authorize(), and none of that reads this field. So this is a low
          -stakes act treated as one — no receipt, human only, on the record. It is also how a seat
          gets re-pointed, which is what brought Whitney back to teach and Percy back to judge
          landing pages. */}
      {isMp && (
        <form
          className="form-row retitle"
          data-testid={`employee-retitle-${id}`}
          onSubmit={async (e) => {
            e.preventDefault();
            const next = newTitle.trim();
            if (!next || next === d.employee.role) return;
            setRetitling(true);
            const res = await api<{ was?: string; detail?: string; error?: string }>(`/api/workforce/${id}/role`, {
              method: "PATCH",
              body: { role: next, reason: `retitled by ${me.fullName}` },
            });
            setRetitling(false);
            setMessage(
              res.status === 200
                ? `${d.employee.name} is now ${next}. Was ${res.data?.was ?? d.employee.role}.`
                : `Could not retitle: ${res.data?.detail ?? res.data?.error ?? res.status}`,
            );
            refresh();
          }}
        >
          <label style={{ flexGrow: 1 }}>
            Title{" "}
            <input
              data-testid={`employee-title-input-${id}`}
              aria-label={`${d.employee.name}'s title`}
              value={newTitle}
              onChange={(ev) => setNewTitle(ev.target.value)}
              placeholder={d.employee.role}
            />
          </label>
          <button type="submit" disabled={retitling || !newTitle.trim() || newTitle.trim() === d.employee.role}>
            {retitling ? "Saving…" : "Change title"}
          </button>
        </form>
      )}

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
        {/* THE COMPLETION STEP. An approved receipt exists but nothing was consuming it, so the
            request→approve→activate chain stopped one link short and the employee never activated.
            This button is the only thing that calls the activate endpoint; it cannot invent a
            receipt, so the cap and the approval remain enforced server-side. */}
        {(() => {
          const receipt = (approvedCards.data?.approvals ?? []).find(
            (c) =>
              c.action_key === "ai_employee.activate" &&
              c.object_type === "ai_employee" &&
              c.object_id === id &&
              c.state === "approved",
          );
          if (!receipt || d.employee.status === "ACTIVE" || d.employee.status === "RETIRED") return null;
          return (
            <button
              type="button"
              data-testid={`employee-activate-${id}`}
              onClick={async () => {
                const res = await api<{ status?: string; error?: string; detail?: string }>(
                  `/api/ai/employees/${id}/activate`,
                  {
                    method: "POST",
                    body: {
                      approval_receipt_id: receipt.id,
                      reason: `activation completed by ${me.fullName} against approved receipt ${receipt.id}`,
                    },
                  },
                );
                setMessage(
                  res.status === 200
                    ? `${d.employee.name} is now ACTIVE.`
                    : `Refused: ${res.data?.detail ?? res.data?.error ?? res.status}`,
                );
                refresh();
                approvedCards.reload();
              }}
            >
              Activate (approved)
            </button>
          );
        })()}

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
                aria-label="What the review found" data-testid={`employee-review-finding-${id}`}
                value={finding}
                onChange={(e) => setFinding(e.target.value)}
                placeholder="What did you observe?"
              />
              <select aria-label="What happens to this employee" data-testid={`employee-review-disposition-${id}`} value={disposition} onChange={(e) => setDisposition(e.target.value)}>
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
              className="field-wide" data-testid="room-announce-body" aria-label="What to announce to the firm"
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
  const [statusFilter, setStatusFilter] = useState<"ALL" | "ACTIVE" | "NOT_ACTIVE">("ALL");
  /**
   * FEEDBACK, because the operator's report was that "you press it and nothing happens".
   *
   * Requesting an activation, pausing, resuming and un-retiring all did their work and said nothing
   * — the list reloaded and a badge somewhere changed. `busyId` disables the control that was
   * pressed and says it is working; `flash` states what changed, in a sentence, and marks the
   * affected card so the eye can find it. A state change nobody can see reads as a broken button.
   */
  const isMp = me.roles.includes("MANAGING_PARTNER");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ id: string; text: string; tone: "ok" | "bad" } | null>(null);
  const [advice, setAdvice] = useState<{ id: string; verdict: string; why: string; watchFor: string; newRole: string | null } | null>(null);

  async function adviseUnretire(id: string, name: string) {
    setBusyId(id);
    setAdvice(null);
    const res = await api<{ verdict?: string; why?: string; watchFor?: string; newRole?: string | null; detail?: string; error?: string }>(
      `/api/workforce/${id}/unretire-advice`,
      { method: "POST", body: {} },
    );
    setBusyId(null);
    if (res.status === 200 && res.data?.verdict) {
      setAdvice({ id, verdict: res.data.verdict, why: res.data.why ?? "", watchFor: res.data.watchFor ?? "", newRole: res.data.newRole ?? null });
    } else {
      setFlash({ id, text: `Could not get advice on ${name}: ${res.data?.detail ?? res.data?.error ?? res.status}`, tone: "bad" });
    }
  }

  async function unretire(id: string, name: string, role: string) {
    setBusyId(id);
    const res = await api<{ note?: string; detail?: string; error?: string }>(`/api/workforce/${id}/unretire`, {
      method: "POST",
      body: { new_role: role, reason: `brought back from the lounge by ${me.fullName}` },
    });
    setBusyId(null);
    setAdvice(null);
    setFlash(
      res.status === 200
        ? { id, text: res.data?.note ?? `${name} is back on the roster.`, tone: "ok" }
        : { id, text: `Could not bring ${name} back: ${res.data?.detail ?? res.data?.error ?? res.status}`, tone: "bad" },
    );
    lounge.reload();
  }
  const [query, setQuery] = useState("");
  /** Refusals from the on/off toggle. Only ever set on failure — a working toggle speaks by
      changing the button, not by announcing itself. */
  const [message, setMessage] = useState<string | null>(null);
  // The opened record is rendered BELOW a grid that can be a full screen tall, so without this the
  // Open button appears to do nothing at all.
  const detailRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!selected) return;
    detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    // Move focus too: a sighted operator gets the scroll, a keyboard or screen-reader user gets
    // nothing from scrolling alone.
    detailRef.current?.focus({ preventScroll: true });
  }, [selected]);

  if (lounge.loading && !lounge.data) return <p data-testid="lounge-loading">Loading the workforce…</p>;
  if (!lounge.data) return <p data-testid="lounge-error">Could not load the workforce (HTTP {lounge.status ?? "?"}).</p>;

  // RETIRED EMPLOYEES ARE NOT THE WORKFORCE. Fourteen of the thirty-one people on this page had
  // been retired in a roster cull, and they were rendered exactly like everyone else — so almost
  // half of what you scrolled past was a list of people who do not work here. Retirement is kept
  // in the record, and the record is not this page.
  const roster = lounge.data.employees.filter((e) => e.status !== "RETIRED");
  const retiredCount = lounge.data.employees.length - roster.length;

  const q = query.trim().toLowerCase();
  const matches = (e: LoungeEmployee) =>
    q.length === 0 ||
    e.name.toLowerCase().includes(q) ||
    e.role.toLowerCase().includes(q) ||
    e.department.toLowerCase().includes(q);

  const visible = roster
    .filter((e) => (department === "ALL" ? true : e.department === department))
    .filter((e) => (statusFilter === "ALL" ? true : statusFilter === "ACTIVE" ? e.status === "ACTIVE" : e.status !== "ACTIVE"))
    .filter(matches);

  // GROUPED BY TEAM, because "who handles LP questions" is the question people actually arrive
  // with, and a flat alphabetical grid of seventeen strangers cannot answer it. Within a team,
  // whoever is working comes first.
  const teams = new Map<string, LoungeEmployee[]>();
  for (const e of visible) {
    const list = teams.get(e.department) ?? [];
    list.push(e);
    teams.set(e.department, list);
  }
  const grouped = [...teams.entries()]
    .map(([team, list]) => [
      team,
      list.slice().sort((a, b) => {
        if (a.status === "ACTIVE" && b.status !== "ACTIVE") return -1;
        if (b.status === "ACTIVE" && a.status !== "ACTIVE") return 1;
        return a.name.localeCompare(b.name);
      }),
    ] as const)
    .sort((a, b) => a[0].localeCompare(b[0]));

  const activeCount = roster.filter((e) => e.status === "ACTIVE").length;

  return (
    <section data-testid="employees-page">
      <p data-testid="lounge-activation-law" className="muted small">
        {lounge.data.active_count} of {lounge.data.max_active} employed. {lounge.data.activation_law}
      </p>

      <OnDutyPanel />

      {message && <p className="notice" data-testid="lounge-message">{message}</p>}

      <div className="form-row">
        <label>
          Department{" "}
          <select data-testid="lounge-department" value={department} onChange={(e) => setDepartment(e.target.value)}>
            {/* COUNTS WHAT IS ON THE PAGE, not what is in the table. This said "All (31)" while
                showing sixteen: `lounge.data.employees` includes retired seats, and the grid below
                deliberately hides them — so the number and the list disagreed, and the number was
                describing a firm that has not existed since the roster was consolidated. */}
            <option value="ALL">All ({roster.length})</option>
            {/* Each department carries its own count for the same reason "All" now does — picking a
                team should tell you how many people are on it before you pick it. */}
            {lounge.data.departments.map((d) => (
              <option key={d} value={d}>
                {d} ({roster.filter((e) => e.department === d).length})
              </option>
            ))}
          </select>
        </label>
        <label>
          Show{" "}
          <select
            data-testid="lounge-status-filter"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as "ALL" | "ACTIVE" | "NOT_ACTIVE")}
          >
            <option value="ALL">Everyone ({roster.length})</option>
            <option value="ACTIVE">Working now ({activeCount})</option>
            <option value="NOT_ACTIVE">Not working ({roster.length - activeCount})</option>
          </select>
        </label>
        <label style={{ flexGrow: 1 }}>
          Find{" "}
          <input
            data-testid="lounge-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="a name, a role, or what you need doing"
          />
        </label>
      </div>

      {/* WHAT JUST HAPPENED. Every action in this section used to complete in silence. */}
      {flash && (
        <p className={flash.tone === "ok" ? "notice notice-ok" : "notice"} data-testid="lounge-flash" role="status">
          {flash.text}{" "}
          <button type="button" className="link-button" onClick={() => setFlash(null)}>dismiss</button>
        </p>
      )}

      <p className="muted small" data-testid="lounge-status-summary">
        <strong>{activeCount} working</strong> · {roster.length - activeCount} employed but not on ·{" "}
        {visible.length} shown
      </p>

      {grouped.map(([team, members]) => (
      <div key={team} data-testid={`lounge-team-${team}`}>
      <div className="home-section-head team-head">
        <h3>{team}</h3>
        <span className="muted small">
          {members.filter((m) => m.status === "ACTIVE").length} of {members.length} working
        </span>
      </div>
      <div className="module-grid" data-testid="lounge-grid">
        {members.map((e) => (
          <section
            key={e.id}
            className={
              e.id === selected
                ? "module-card employee-card-open"
                : e.status === "ACTIVE"
                  ? "module-card employee-card-active"
                  : "module-card"
            }
            data-testid={`employee-card-${e.id}`}
            data-status={e.status}
            data-open={e.id === selected ? "true" : "false"}
          >
            <header className="module-card-head">
              <h4>
                {portraitFor(e.name) ? (
                  <img
                    className="employee-portrait"
                    src={portraitFor(e.name)!}
                    alt={portraitAlt(e.name, e.role)}
                    width={44}
                    height={44}
                    loading="lazy"
                    /* A missing or failed portrait falls back to initials rather than a broken
                       image icon — the lounge should degrade quietly. */
                    onError={(ev) => {
                      (ev.currentTarget as HTMLImageElement).style.display = "none";
                    }}
                  />
                ) : (
                  <span className="avatar">{e.avatar_initials}</span>
                )}{" "}
                {e.name}
              </h4>
              <span className={statusBadge(e.status)}>{e.status}</span>
            </header>
            <EmploymentSwitch employee={e} onChanged={() => lounge.reload()} onMessage={setMessage} />
            <p className="module-answers">{e.role}</p>
            {/* P32: the lounge should show who someone IS. Title + brief described a job slot;
                expertise and voice describe a colleague you might choose to confer with. */}
            {personaFor(e.name) && (
              <>
                <p className="small employee-expertise">{personaFor(e.name)!.expertise}</p>
                <p className="muted small employee-voice">{personaFor(e.name)!.voice}</p>
              </>
            )}
            {/* The bio answers "who is this", which is the question you have to answer before
                deciding whether they can sit in front of a founder. */}
            <p className="small">{e.bio ?? e.brief}</p>
            {e.face && (
              <p className="muted small" data-testid={`employee-face-${e.id}`}>
                {e.face === "EXTERNAL_CAPABLE"
                  ? "Can meet people outside the firm, when you put them there."
                  : "Internal only — never appears to anyone outside the firm."}
              </p>
            )}
            <p className="muted small">
              {e.department} · {e.current_work.length} open card(s) · {e.runs_30d} run(s)/30d ({e.blocked_runs_30d} blocked) · $
              {e.cost_30d_usd.toFixed(4)}
            </p>
            {e.tool_scopes.length > 0 && <p className="muted small">tools: {e.tool_scopes.join(", ")}</p>}
            <button
              type="button"
              className="link-button"
              data-testid={`employee-open-${e.id}`}
              aria-expanded={e.id === selected}
              aria-controls="employee-detail-anchor"
              onClick={() => setSelected(e.id)}
            >
              {e.id === selected ? "Open below ↓" : "Open"}
            </button>
          </section>
        ))}
      </div>
      </div>
      ))}
      {visible.length === 0 && (
        <p className="state-empty" data-testid="lounge-none">
          {query.trim()
            ? `Nobody matches “${query.trim()}”. Try a role — “LP”, “events”, “diligence”.`
            : "Nobody matches those filters."}
        </p>
      )}

      {/* Kept, folded, and named for what it is. Retirement is part of the record — a seat that
          existed and then did not — but it is not the workforce, and it was taking up half this
          page. */}
      {retiredCount > 0 && (
        <details className="card" data-testid="lounge-retired">
          <summary>
            Former employees <span className="muted small">{retiredCount}</span>
          </summary>
          <p className="muted small">
            Seats that were merged away when the roster was cut. Kept because what the firm used to
            look like is part of the record, and shown here so they are findable without being in
            the way.
          </p>
          <ul className="retired-list">
            {lounge.data.employees
              .filter((e) => e.status === "RETIRED")
              .map((e) => (
                <li key={e.id} className="retired-person" data-testid={`retired-${e.id}`}>
                  {/* THEY HAVE FACES AGAIN. All thirty-one portraits are committed, so somebody
                      returning from retirement no longer arrives as a grey initial on the page
                      whose whole job is making the workforce feel like people. */}
                  {portraitFor(e.name) ? (
                    <img className="owner-face" src={portraitFor(e.name)!} alt={portraitAlt(e.name, e.role)} loading="lazy" />
                  ) : (
                    <span className="owner-face owner-face-initial" aria-hidden="true">{e.name.slice(0, 1)}</span>
                  )}
                  <span className="retired-who">
                    <strong>{e.name}</strong> <span className="muted small">{e.role}</span>
                  </span>
                  {isMp && (
                    <span className="retired-actions">
                      {/* ADVICE BEFORE THE BUTTON, deliberately in that order. The roster went from
                          thirty-one seats to seventeen because several pairs were the same job
                          wearing two titles, and every un-retirement risks recreating exactly that.
                          The advisor is asked one narrow question — does this seat answer something
                          the current roster cannot — and it decides nothing. */}
                      <button
                        type="button"
                        className="link-button"
                        disabled={busyId === e.id}
                        data-testid={`retired-advise-${e.id}`}
                        onClick={() => void adviseUnretire(e.id, e.name)}
                      >
                        {busyId === e.id ? "Thinking…" : "Should we?"}
                      </button>
                      <button
                        type="button"
                        className="link-button"
                        disabled={busyId === e.id}
                        data-testid={`retired-unretire-${e.id}`}
                        onClick={() => void unretire(e.id, e.name, e.role)}
                      >
                        Bring back
                      </button>
                    </span>
                  )}
                  {advice?.id === e.id && (
                    <div className={`unretire-advice verdict-${advice.verdict.toLowerCase()}`} data-testid={`retired-advice-${e.id}`}>
                      <p>
                        <span className="badge">{advice.verdict.replace(/_/g, " ").toLowerCase()}</span>{" "}
                        {advice.why}
                      </p>
                      {advice.newRole && (
                        <p className="small">
                          Suggested title: <strong>{advice.newRole}</strong>{" "}
                          <button
                            type="button"
                            className="link-button"
                            data-testid={`retired-accept-role-${e.id}`}
                            onClick={() => void unretire(e.id, e.name, advice.newRole!)}
                          >
                            bring back as this
                          </button>
                        </p>
                      )}
                      {advice.watchFor && <p className="muted small">Watch for: {advice.watchFor}</p>}
                    </div>
                  )}
                </li>
              ))}
          </ul>
        </details>
      )}

      {selected && (
        <div id="employee-detail-anchor" ref={detailRef} tabIndex={-1} data-testid="employee-detail-anchor">
          <div className="detail-lead">
            <h3>
              Editing {lounge.data.employees.find((x) => x.id === selected)?.name ?? "employee"}
            </h3>
            <p className="muted small">
              This is the record you opened — lifecycle, activation, tools and manager review are
              changed here.
            </p>
            <button type="button" className="link-button" data-testid="employee-detail-close" onClick={() => setSelected(null)}>
              Close
            </button>
          </div>
          <EmployeeDetailPanel id={selected} me={me} onChanged={lounge.reload} />
        </div>
      )}

      <HandoffsPanel onChanged={lounge.reload} />
      <RoomsPanel me={me} />
    </section>
  );
}

/**
 * Who is on duty right now.
 *
 * Everyone employed stays available all day; this is the short list the firm is leaning on at this
 * hour. It exists because the cap coming off made the roster screen worse in one specific way —
 * thirty names, all equally present, none of them the one you need. Availability is not attention.
 *
 * The hour is sent from the browser rather than read on the server: a Worker runs in UTC and the
 * partner does not, and a rota that is silently three hours out is worse than no rota.
 */
function OnDutyPanel() {
  const [hour] = useState(() => new Date().getHours());
  const [pinned, setPinned] = useState<string[]>([]);
  const query = `/api/ai/employees/on-duty?hour=${hour}${pinned.length ? `&pinned=${pinned.join(",")}` : ""}`;
  const duty = useApi<{
    label: string;
    intent: string;
    onDuty: Array<{ name: string; role: string; because: string }>;
    benched: string[];
    active_count: number;
    how_it_works: string;
  }>(query, [query]);

  if (duty.loading && !duty.data) return null;
  const d = duty.data;
  if (!d) return null;

  return (
    <section className="card" data-testid="on-duty">
      <header className="module-card-head">
        <h3 className="duty-heading">
          On duty now <span className="module-count">{d.label}</span>
          {/* IS ANYTHING ACTUALLY RUNNING. The heading named the shift and said nothing about
              whether the firm is working — green means somebody is on point this hour, amber means
              the rota named people and none of them are switched on. That second state is the one
              worth catching, because the page looks identical either way.

              Never colour alone: the word beside the dot carries the same meaning, and the dot is
              aria-hidden so a screen reader gets the word once rather than twice. */}
          <span
            className={d.onDuty.length > 0 ? "health-dot health-ok" : "health-dot health-warn"}
            data-testid="duty-health"
            aria-hidden="true"
          />
          <span className="muted small">{d.onDuty.length > 0 ? "working" : "nobody on"}</span>
        </h3>
        {pinned.length > 0 && (
          <button type="button" className="link-button" data-testid="on-duty-clear-pins" onClick={() => setPinned([])}>
            Clear pins
          </button>
        )}
      </header>
      <p className="muted small">{d.intent}</p>

      {d.onDuty.length === 0 ? (
        <p className="state-empty" data-testid="on-duty-empty">
          Nobody is on duty this hour. Everyone rostered for this shift is switched off — turn
          someone on below and they will appear here.
        </p>
      ) : (
        <ul className="card-list" data-testid="on-duty-list">
          {d.onDuty.map((x) => (
            <li key={x.name} data-testid={`on-duty-${x.name}`}>
              <strong>{x.name}</strong> — {x.role}
              <br />
              <span className="muted small">{x.because}</span>
            </li>
          ))}
        </ul>
      )}

      {d.benched.length > 0 && (
        <p className="muted small" data-testid="on-duty-benched">
          Also rostered for this shift, not on point:{" "}
          {d.benched.map((n, i) => (
            <span key={n}>
              {i > 0 && " · "}
              <button
                type="button"
                className="link-button"
                data-testid={`on-duty-pin-${n}`}
                onClick={() => setPinned((p) => (p.includes(n) ? p : [...p, n]))}
              >
                {n}
              </button>
            </span>
          ))}
          . Click a name to put them on point.
        </p>
      )}

      <p className="muted small">{d.how_it_works}</p>
    </section>
  );
}
