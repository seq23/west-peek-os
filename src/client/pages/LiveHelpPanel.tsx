import { useState } from "react";
import { api, useApi } from "../lib/api";
import { portraitAlt, portraitFor } from "../lib/employeePortraits";

/**
 * Live Help — the meeting workspace's chat with AI employees (canon §3, §28.5).
 *
 * "The Live Help tab is where Walter lives." Designed for use DURING a meeting, which drives every
 * choice here: quick actions before the text box (you are half-listening, not composing), newest
 * turn last, short answers, and refusals shown in the transcript rather than swallowed.
 *
 * It seats employees; it never activates them. An INACTIVE employee cannot be seated, and the
 * refusal says where to go — the ≤5 cap and the approval receipt stay where they are.
 */

interface SeatedEmployee {
  ai_employee_id: string;
  name: string;
  role: string;
  status: string;
}

interface ChatTurn {
  id: string;
  turn_no: number;
  role: string;
  ai_employee_id: string | null;
  body: string;
  state: string;
  detail: string | null;
  created_at: string;
}

interface QuickAction {
  key: string;
  label: string;
  prompt: string;
}

interface LiveHelpResponse {
  seated: SeatedEmployee[];
  turns: ChatTurn[];
  quick_actions: QuickAction[];
  ai_access_state: string;
  ai_access_note: string | null;
}

interface RosterEmployee {
  id: string;
  name: string;
  role: string;
  status: string;
}

export function LiveHelpPanel({ meetingId }: { meetingId: string }): JSX.Element {
  const state = useApi<LiveHelpResponse>(`/api/meetings/${meetingId}/live-help`);
  const roster = useApi<{ employees: RosterEmployee[] }>("/api/ai/employees");
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const seated = state.data?.seated ?? [];
  const revoked = state.data?.ai_access_state === "REVOKED";
  const seatedIds = new Set(seated.map((s) => s.ai_employee_id));
  // Only ACTIVE employees can be seated, so only they are offered. Showing the other 26 as
  // disabled options would be a menu of things that cannot happen.
  const available = (roster.data?.employees ?? []).filter(
    (e) => e.status === "ACTIVE" && !seatedIds.has(e.id),
  );

  async function ask(text: string) {
    if (!text.trim() || busy) return;
    setBusy(true);
    setMessage(null);
    const res = await api<{ error?: string; detail?: string }>(`/api/meetings/${meetingId}/live-help`, {
      method: "POST",
      body: { question: text },
    });
    if (res.status !== 201) setMessage(res.data?.detail ?? res.data?.error ?? `Failed (HTTP ${res.status}).`);
    setQuestion("");
    setBusy(false);
    state.reload();
  }

  return (
    <section className="live-help" data-testid={`live-help-${meetingId}`}>
      <h4>Live Help</h4>

      {revoked ? (
        <div className="notice" data-testid="live-help-revoked">
          <strong>AI access to this room is revoked.</strong> No AI employee can read the notes,
          answer here, or process follow-up. You can keep taking notes yourself.
          {state.data?.ai_access_note && <div className="muted small">{state.data.ai_access_note}</div>}
          <div className="form-row">
            <button
              type="button"
              data-testid="live-help-restore"
              onClick={async () => {
                await api(`/api/meetings/${meetingId}/ai-access/restore`, { method: "POST", body: {} });
                state.reload();
              }}
            >
              Restore AI access
            </button>
          </div>
        </div>
      ) : (
        <div className="form-row">
          {/* Prominent, per canon §9.6.2E — and destructive enough to confirm first. */}
          <button
            type="button"
            className="btn-danger"
            data-testid="live-help-revoke-all"
            onClick={async () => {
              if (!confirm("Revoke all AI access to this room? Everyone seated is removed and nobody can be seated again until you restore access.")) return;
              await api(`/api/meetings/${meetingId}/ai-access/revoke`, { method: "POST", body: {} });
              state.reload();
            }}
          >
            Revoke all AI access
          </button>
        </div>
      )}

      {/* Who is in the room. */}
      <div className="live-help-seats" data-testid="live-help-seats">
        {seated.length === 0 ? (
          <p className="muted small" data-testid="live-help-nobody">
            No one is helping yet. Add an active employee to confer with during this meeting.
          </p>
        ) : (
          seated.map((s) => (
            <span key={s.ai_employee_id} className="help-tag help-tag-good" data-testid={`live-help-seat-${s.ai_employee_id}`}>
              {portraitFor(s.name) && (
                <img
                  className="employee-portrait"
                  src={portraitFor(s.name)!}
                  alt={portraitAlt(s.name, s.role)}
                  width={22}
                  height={22}
                  loading="lazy"
                  onError={(ev) => {
                    (ev.currentTarget as HTMLImageElement).style.display = "none";
                  }}
                />
              )}
              {s.name} · {s.role}{" "}
              <button
                type="button"
                className="link-button"
                aria-label={`Remove ${s.name} from this meeting`}
                onClick={async () => {
                  await api(`/api/meetings/${meetingId}/employees/release`, {
                    method: "POST",
                    body: { ai_employee_id: s.ai_employee_id },
                  });
                  state.reload();
                }}
              >
                ×
              </button>
            </span>
          ))
        )}
      </div>

      {available.length > 0 ? (
        <div className="form-row">
          <label>
            Add helper{" "}
            <select
              data-testid="live-help-add"
              defaultValue=""
              onChange={async (e) => {
                if (!e.target.value) return;
                const res = await api<{ detail?: string; error?: string }>(`/api/meetings/${meetingId}/employees`, {
                  method: "POST",
                  body: { ai_employee_id: e.target.value },
                });
                if (res.status !== 201) setMessage(res.data?.detail ?? `Could not add (HTTP ${res.status}).`);
                e.target.value = "";
                state.reload();
              }}
            >
              <option value="">Choose…</option>
              {available.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name} — {e.role}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : (
        seated.length === 0 && (
          <p className="notice" data-testid="live-help-none-active">
            No AI employee is active yet, so no one can help in this meeting. Activate someone on{" "}
            <strong>Team → Employees</strong> — it needs a Managing Partner approval receipt.
          </p>
        )
      )}

      {/* The conversation. */}
      <ul className="live-help-thread" data-testid="live-help-thread">
        {(state.data?.turns ?? []).map((t) => (
          <li
            key={t.id}
            className={t.role === "OPERATOR" ? "turn turn-mp" : t.state === "OK" ? "turn turn-ai" : "turn turn-blocked"}
            data-testid={`live-help-turn-${t.turn_no}`}
          >
            <span className="turn-who">
              {t.role === "OPERATOR"
                ? "You"
                : seated.find((s) => s.ai_employee_id === t.ai_employee_id)?.name ?? "Assistant"}
            </span>
            <span className="turn-body">{t.body}</span>
            {t.state !== "OK" && t.detail && (
              <span className="turn-detail" data-testid={`live-help-blocked-${t.turn_no}`}>
                {t.detail}
              </span>
            )}
          </li>
        ))}
        {(state.data?.turns ?? []).length === 0 && (
          <li className="state-empty">Nothing asked yet.</li>
        )}
      </ul>

      {/* Quick actions come BEFORE the text box: mid-meeting you tap, you do not compose. */}
      <div className="live-help-quick" data-testid="live-help-quick">
        {(state.data?.quick_actions ?? []).map((q) => (
          <button
            key={q.key}
            type="button"
            disabled={busy || seated.length === 0}
            data-testid={`live-help-quick-${q.key}`}
            onClick={() => ask(q.prompt)}
          >
            {q.label}
          </button>
        ))}
      </div>

      <form
        className="form-row"
        data-testid="live-help-form"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(question);
        }}
      >
        <input
          data-testid="live-help-input" aria-label="Ask the employees in this meeting"
          value={question}
          placeholder="Ask the room…"
          disabled={busy || seated.length === 0}
          onChange={(e) => setQuestion(e.target.value)}
        />
        <button type="submit" className="btn-strong" disabled={busy || seated.length === 0} data-testid="live-help-send">
          {busy ? "Asking…" : "Ask"}
        </button>
      </form>

      {message && <p className="notice" data-testid="live-help-message">{message}</p>}
      <p className="muted small">
        Internal only. Anything drafted here is a draft — nothing is sent without your approval.
      </p>
    </section>
  );
}
