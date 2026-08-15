import { useState } from "react";
import { api, useApi, type MeResponse } from "../lib/api";

/**
 * Integrations (P22–P24; GAP-15, GAP-16, GAP-17, GAP-18).
 *
 * The page that tells an operator the truth about the outside world: which connectors exist,
 * what each would need, which gate stands in front of it, what the specialist lane can and
 * cannot do, and where administrator/VDR data would come from.
 *
 * Nothing here is presented as working. Every unproven thing says so, by name.
 */

interface Connector {
  id: string;
  connector_key: string;
  name: string;
  kind: string;
  owns: string;
  direction: string;
  credential_name: string | null;
  credential_configured: boolean;
  scopes: string[];
  consent_required: number;
  approval_gate: string;
  status: string;
  detail: string;
  last_checked_at: string | null;
}

interface PrepRow {
  id: string;
  title: string;
  meeting_type: string;
  scheduled_at: string;
  needs_prep: boolean;
  recording_state: string;
  participants: number;
}

function statusBadge(status: string): string {
  if (status === "CONFIGURED") return "badge badge-ok";
  if (status === "FAILED") return "badge badge-bad";
  return "badge badge-gate";
}

export function IntegrationsPage({ me }: { me: MeResponse }) {
  const connectors = useApi<{ connectors: Connector[]; network_os: { authority: string; contract_declared: boolean; open_conflicts: number; mapped_records: number }; rules: Record<string, string> }>(
    "/api/connectors",
  );
  const prep = useApi<{ queue: PrepRow[]; note: string }>("/api/meeting-prep/queue");
  const specialist = useApi<{ engagements: Array<{ id: string; provider_key: string; matter_type: string; status: string; block_reason: string | null }>; providers: Array<{ provider_key: string; display_name: string; enabled: number; allowed_labels: number; credential_configured: boolean; endpoint_known: boolean }>; status: string; gate_detail: string }>(
    "/api/specialist/engagements",
  );
  const lpOps = useApi<{
    sources: Array<{ source_key: string; name: string; kind: string; contract_state: string; freshness: string; note: string }>;
    reconciliation_schedules: Array<{ fund_name: string; cadence: string; next_due_at: string; due: boolean }>;
    outstanding_diligence: Array<{ id: string; request_text: string; status: string }>;
    data_room_access: Array<{ id: string; recipient_label: string; permission: string; revoked: boolean }>;
    lp_engagements: Array<{ lp_record_id: string; legal_name: string; state: string; next_step: string }>;
    gates: Record<string, string>;
    authority: string;
    error?: string;
    detail?: string;
  }>("/api/lp-ops/overview");
  const [message, setMessage] = useState<string | null>(null);

  return (
    <section data-testid="integrations-page">
      <h3>Connectors</h3>
      <p className="muted small" data-testid="connector-rules">
        {connectors.data?.rules.credentials} {connectors.data?.rules.checks}
      </p>
      <ul className="card-list" data-testid="connector-list">
        {(connectors.data?.connectors ?? []).map((c) => (
          <li key={c.id} className="card" data-testid={`connector-${c.connector_key}`}>
            <p>
              <strong>{c.name}</strong> <span className={statusBadge(c.status)}>{c.status}</span>{" "}
              <span className="badge">{c.direction}</span>
              {c.consent_required === 1 && <span className="badge badge-gate">consent required</span>}
            </p>
            <p className="small">{c.owns}</p>
            <p className="muted small">
              credential {c.credential_name ?? "none declared"} —{" "}
              {c.credential_configured ? "configured" : "NOT configured in this environment"} · scopes{" "}
              {c.scopes.join(", ") || "none"}
            </p>
            <p className="muted small">gate: {c.approval_gate}</p>
            <p className="muted small">{c.detail}</p>
            <button
              type="button"
              data-testid={`connector-check-${c.connector_key}`}
              onClick={async () => {
                const res = await api<{ detail: string }>(`/api/connectors/${c.connector_key}/check`, { method: "POST" });
                setMessage(res.data?.detail ?? `Check failed (HTTP ${res.status}).`);
                connectors.reload();
              }}
            >
              Check configuration
            </button>
          </li>
        ))}
      </ul>
      {message && <p className="notice" data-testid="integrations-message">{message}</p>}

      <section className="card" data-testid="network-os-authority">
        <h4>Network OS</h4>
        <p className="small">{connectors.data?.network_os.authority}</p>
        <p className="muted small">
          adapter contract {connectors.data?.network_os.contract_declared ? "declared" : "not declared"} ·{" "}
          {connectors.data?.network_os.mapped_records ?? 0} mapped record(s) · {connectors.data?.network_os.open_conflicts ?? 0} open
          conflict(s)
        </p>
      </section>

      <h3>Meeting prep queue</h3>
      <p className="notice small" data-testid="prep-note">
        {prep.data?.note}
      </p>
      <ul className="card-list small" data-testid="prep-queue">
        {(prep.data?.queue ?? []).map((m) => (
          <li key={m.id}>
            {m.scheduled_at} — {m.title} ({m.meeting_type}) · {m.participants} participant(s) ·{" "}
            {m.needs_prep ? <span className="badge badge-gate">needs prep</span> : <span className="badge badge-ok">prepped</span>}{" "}
            <span className="muted">{m.recording_state}</span>
          </li>
        ))}
        {!prep.loading && (prep.data?.queue ?? []).length === 0 && <li className="state-empty">No scheduled meetings ahead of now.</li>}
      </ul>

      <h3>Specialist lane</h3>
      <p data-testid="specialist-status">
        <span className="badge badge-gate">{specialist.data?.status}</span>
      </p>
      <p className="muted small" data-testid="specialist-gate">
        {specialist.data?.gate_detail}
      </p>
      <ul className="card-list small" data-testid="specialist-providers">
        {(specialist.data?.providers ?? []).map((p) => (
          <li key={p.provider_key}>
            <strong>{p.display_name}</strong> — {p.enabled ? "enabled" : "disabled"} · {p.allowed_labels} data class(es) allowed to
            egress · credential {p.credential_configured ? "configured" : "not configured"} · endpoint{" "}
            {p.endpoint_known ? "known" : "unknown"}
          </li>
        ))}
      </ul>
      <ul className="card-list small" data-testid="specialist-engagements">
        {(specialist.data?.engagements ?? []).map((e) => (
          <li key={e.id}>
            <code>{e.status}</code> {e.provider_key} · {e.matter_type}
            {e.block_reason ? ` — ${e.block_reason}` : ""}
          </li>
        ))}
        {!specialist.loading && (specialist.data?.engagements ?? []).length === 0 && (
          <li className="state-empty">No specialist engagements. Opening one runs through the governed AI boundary like any other call.</li>
        )}
      </ul>

      <h3>LP operations</h3>
      {lpOps.data?.error ? (
        <p className="muted" data-testid="lp-ops-forbidden">
          {lpOps.data.detail}
        </p>
      ) : (
        <>
          <p className="muted small" data-testid="lp-ops-authority">
            {lpOps.data?.authority}
          </p>
          <ul className="card-list small" data-testid="lp-ops-sources">
            {(lpOps.data?.sources ?? []).map((s) => (
              <li key={s.source_key}>
                <strong>{s.name}</strong> <span className="badge badge-gate">{s.contract_state}</span> — {s.freshness}
                <br />
                <span className="muted">{s.note}</span>
              </li>
            ))}
          </ul>
          <ul className="card-list small" data-testid="lp-ops-schedules">
            {(lpOps.data?.reconciliation_schedules ?? []).map((s) => (
              <li key={s.fund_name}>
                {s.fund_name} — {s.cadence}, next {s.next_due_at} {s.due && <span className="badge badge-bad">due</span>}
              </li>
            ))}
            {(lpOps.data?.reconciliation_schedules ?? []).length === 0 && <li className="state-empty">No reconciliation schedule set.</li>}
          </ul>
          <ul className="card-list small" data-testid="lp-ops-engagements">
            {(lpOps.data?.lp_engagements ?? []).map((e) => (
              <li key={e.lp_record_id}>
                {e.legal_name} — <code>{e.state}</code> {e.next_step}
              </li>
            ))}
            {(lpOps.data?.lp_engagements ?? []).length === 0 && <li className="state-empty">No LP engagement states recorded.</li>}
          </ul>
          <ul className="notice small" data-testid="lp-ops-gates">
            {Object.entries(lpOps.data?.gates ?? {}).map(([k, v]) => (
              <li key={k}>
                <code>{k}</code> — {v}
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="muted small">Signed in as {me.fullName}.</p>
    </section>
  );
}
